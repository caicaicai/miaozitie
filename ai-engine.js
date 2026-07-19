// 喵字帖 - AI 内容生成共享引擎（实验性功能）
//
// 基于 Transformers.js + Qwen2.5-0.5B-Instruct，模型完全在浏览器本地运行，不经过
// 任何服务器。各功能页面（如 tingxie.html、moxie.html）可以 import 这个模块，复用
// 模型加载与生成逻辑，并通过 hasModelBeenLoadedBefore() 判断是否要展示"AI 辅助生成"界面。
//
// 关于模型选择（分档机制）：之前用的 MiniCPM5-1B（q4，902MB 单文件）在内存偏紧的
// 设备上（尤其部分 Mac）下载/初始化时会因内存不足导致浏览器崩溃（Chrome error
// code 5 = OOM）。现在按检测到的硬件能力分成几档（见 MODEL_TIERS），由
// getModelPlan() 自动推荐最适合当前设备的一档：
//   - standard（默认推荐）：Qwen2.5-0.5B q4f16，约 483MB，需要 GPU 支持 shader-f16
//   - compat（兼容档）：Qwen2.5-0.5B q4，约 786MB，不需要 f16，给不支持 f16 的显卡用
//   - plus（加强档，仅手动选择）：Qwen2.5-1.5B q4f16，约 1.2GB，质量更好但内存
//     风险高——浏览器无法可靠检测"空闲"内存（navigator.deviceMemory 上限报 8、
//     且报的是总内存），实测 16GB 的 Mac 都可能在 900MB 级下载时 OOM 崩溃，
//     所以这一档永远不自动选，只作为用户知情后的手动选项
//
// 注意：localStorage 标记只表示"这个浏览器之前成功加载过一次"，用来推测这次加载
// 大概率会很快（模型文件已被浏览器缓存），而不是精确判断缓存是否仍然有效——
// 就算标记存在，真正调用生成时仍可能触发一次下载（例如用户清理过浏览器数据）。

const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const READY_FLAG_KEY = 'miaozitie_ai_model_ready';
const TIER_PREF_KEY = 'miaozitie_ai_model_tier';

// risky: true 的档位永远不会被自动推荐，只在硬件大致够格时作为手动选项放出；
// minBufferMB 是该档对 GPU maxBufferSize 的最低要求（装不下权重大文件就隐藏）。
export const MODEL_TIERS = {
    plus: {
        key: 'plus',
        modelId: 'onnx-community/Qwen2.5-1.5B-Instruct',
        dtype: 'q4f16',
        needsF16: true,
        risky: true,
        minBufferMB: 1600,
        downloadMB: 1250,
        label: '加强版 Qwen2.5-1.5B（约 1.2GB）',
        description: '回答质量明显更好，但下载/内存占用是标准版的 2.5 倍，内存不足时浏览器会直接崩溃。仅建议独立显卡、内存充裕且其它应用较少的电脑手动选用。'
    },
    minicpm: {
        key: 'minicpm',
        modelId: 'skjortan/MiniCPM5-1B-ONNX',
        dtype: 'q4f16',
        needsF16: true,
        risky: true,
        minBufferMB: 1200,
        downloadMB: 931,
        label: 'MiniCPM5-1B（约 930MB）',
        description: '面壁智能的 1B 模型，社区评测中文能力口碑不错，介于标准版和加强版之间。体积约 930MB，内存偏紧的设备（实测部分 16GB 内存的 Mac）加载时有崩溃风险，请自行权衡。'
    },
    standard: {
        key: 'standard',
        modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
        dtype: 'q4f16',
        needsF16: true,
        risky: false,
        minBufferMB: 0,
        downloadMB: 483,
        label: '标准版 Qwen2.5-0.5B（约 480MB）',
        description: '体积小、加载快、崩溃风险低，能力上限有限（适合词语生成等简单任务）。大多数设备的推荐选择。'
    },
    compat: {
        key: 'compat',
        modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
        dtype: 'q4',
        needsF16: false,
        risky: false,
        minBufferMB: 0,
        downloadMB: 786,
        label: '兼容版 Qwen2.5-0.5B（约 780MB，无需 fp16）',
        description: '给不支持 shader-f16 的显卡使用：能力与标准版相同，但文件更大、占用内存更多。'
    }
};

// UI 展示顺序：常规档在前，体积从小到大
const TIER_ORDER = ['standard', 'compat', 'minicpm', 'plus'];

let generatorPromise = null;
let activeTierKey = null; // 当前页面这次会话中实际加载（或正在加载）的档位

// 给一个 Promise 加超时保护：超过 ms 毫秒还没有 resolve/reject，就直接用
// fallbackValue "顶上"，不让调用方永远卡住。部分浏览器（尤其是一些手机浏览器）
// 里 navigator.gpu.requestAdapter() / requestAdapterInfo() 可能会一直不返回，
// 既不成功也不报错，所以这里不能只靠 try/catch。
function withTimeout(promise, ms, fallbackValue) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(fallbackValue);
        }, ms);

        Promise.resolve(promise).then((value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }).catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(fallbackValue);
        });
    });
}

// 只判断 `navigator.gpu` 是否存在并不可靠：有些浏览器/设备组合下这个 API 存在，
// 但实际拿不到真实显卡适配器（会得到软件模拟的 fallback adapter，速度跟纯 CPU
// 差不多）；即使拿到了真实适配器，如果是集成显卡（核显），对 1B 参数模型这种
// 计算量来说仍然会比独立显卡慢很多。这个函数尽量把这些情况区分清楚，方便页面
// 给用户一个诚实的性能预期，而不是简单地说"支持/不支持 WebGPU"。
//
// 另外要注意：q4 量化模型用到的部分算子（如 4bit 的 GatherBlockQuantized）
// 目前只有 WebGPU 版本的实现、没有对应的 WASM(CPU) 内核，所以如果完全没有可用
// 的 WebGPU 适配器，这个模型可能不是"慢"，而是直接加载/推理失败。
//
// 手机浏览器上 navigator.gpu.requestAdapter()（或 requestAdapterInfo()）有时会
// 一直不返回结果（既不成功也不报错），所以整个检测过程都套了超时保护，最多
// 等 4 秒，避免页面卡在"正在检测..."上不动。
//
// 返回对象里的 limits 是从适配器读到的关键显存上限（maxStorageBufferBindingSize /
// maxBufferSize），用来在诊断信息里展示，并让 UI 对"上限明显偏小、加载时很可能
// 因显存不足崩溃"的设备提前给出提示。
//
// 检测结果会缓存到 lastGPUDetection：页面加载时先检测一次展示提示，真正点"加载
// 模型"时 preflightWebGPU() 会复用同一个结果，避免重复 requestAdapter。检测超时
// 不缓存（下次仍会重试），因为超时往往是偶发的。
let lastGPUDetection = null;

export async function detectGPUAdapter(forceRefresh) {
    if (lastGPUDetection && !forceRefresh) return lastGPUDetection;

    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        lastGPUDetection = { available: false, isFallback: false, info: null, limits: null, hasF16: false, timedOut: false };
        return lastGPUDetection;
    }

    const detect = (async () => {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return { available: false, isFallback: false, info: null, limits: null, hasF16: false, timedOut: false };
            }

            let info = null;
            try {
                const infoPromise = typeof adapter.requestAdapterInfo === 'function'
                    ? adapter.requestAdapterInfo()
                    : Promise.resolve(adapter.info || null);
                info = await withTimeout(infoPromise, 2000, null);
            } catch (e) {
                info = null; // 部分浏览器出于隐私考虑限制读取详细信息，拿不到也不影响主流程
            }

            const isFallback = !!(adapter.isFallbackAdapter || (info && info.isFallbackAdapter));
            const limits = adapter.limits ? {
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxBufferSize: adapter.limits.maxBufferSize
            } : null;
            // q4f16 模型需要 GPU 支持 shader-f16 特性；提前探测，好在不支持时给出友好提示。
            const hasF16 = !!(adapter.features && typeof adapter.features.has === 'function' && adapter.features.has('shader-f16'));
            return { available: true, isFallback, info, limits, hasF16, timedOut: false };
        } catch (e) {
            return { available: false, isFallback: false, info: null, limits: null, hasF16: false, timedOut: false };
        }
    })();

    const result = await withTimeout(detect, 4000, { available: false, isFallback: false, info: null, limits: null, hasF16: false, timedOut: true });
    if (!result.timedOut) lastGPUDetection = result; // 超时不缓存，留待下次重试
    return result;
}

// 同步、粗略的判断（只看 API 是否存在），仅用于加载模型时决定 device 参数。
// 想要准确判断适配器情况、并给用户展示诊断信息，请用上面的 detectGPUAdapter()。
export function supportsWebGPU() {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

// 之前是否在这个浏览器上成功加载过模型（用来决定要不要展示 AI 辅助生成界面）。
export function hasModelBeenLoadedBefore() {
    try {
        return localStorage.getItem(READY_FLAG_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function markModelLoaded() {
    try {
        localStorage.setItem(READY_FLAG_KEY, '1');
    } catch (e) {
        // 忽略（如隐私模式下 localStorage 不可用）
    }
}

function clearLoadedFlag() {
    try {
        localStorage.removeItem(READY_FLAG_KEY);
    } catch (e) {
        // 忽略
    }
}

// 记住用户上次成功加载的档位：其它页面（tingxie/moxie）调用 generateWithAI 时
// 会沿用这个档位，保证整站用的是同一个模型、且命中已下载的缓存。
function getSavedTierKey() {
    try {
        const key = localStorage.getItem(TIER_PREF_KEY);
        return key && MODEL_TIERS[key] ? key : null;
    } catch (e) {
        return null;
    }
}

function saveTierKey(key) {
    try {
        localStorage.setItem(TIER_PREF_KEY, key);
    } catch (e) {
        // 忽略
    }
}

function isProbablyMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

// 硬件检测 → 模型分档方案。返回：
//   {
//     usable: 是否有真实可用的 WebGPU 显卡（false 时 blockedReason 说明原因）,
//     blockedReason: 不可用时的中文说明,
//     gpu: detectGPUAdapter() 的原始结果,
//     deviceMemoryGB: navigator.deviceMemory（注意：上限只报 8，且是总内存不是空闲内存）,
//     recommendedKey: 自动推荐的档位 key,
//     savedKey: 用户上次成功加载过的档位（如有）,
//     tiers: [{...MODEL_TIERS 条目, allowed, recommended, risky, note}] 供 UI 渲染
//   }
//
// 推荐逻辑刻意保守：显卡明确不支持 f16 → compat；其余 → standard。plus 永远
// 不自动推荐（浏览器检测不出"空闲内存"，见文件头注释），只在硬件大致够格时
// 作为可手动选择的选项放出来。
export async function getModelPlan() {
    const gpu = await detectGPUAdapter();
    const deviceMemoryGB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || null;
    const mobile = isProbablyMobileDevice();

    if (!gpu.timedOut && (!gpu.available || gpu.isFallback)) {
        return {
            usable: false,
            blockedReason: !gpu.available
                ? '未检测到可用的 WebGPU 显卡：这些 4bit 量化模型只有显卡(WebGPU)版本、没有实用的 CPU 版本，无法在此设备上运行。'
                : '检测到的 WebGPU 适配器是软件模拟（并非真实显卡），运行会极慢且很可能让浏览器崩溃。',
            gpu, deviceMemoryGB,
            recommendedKey: null, savedKey: getSavedTierKey(), tiers: []
        };
    }

    // f16 明确不支持 = 成功读到了适配器特性、但列表里没有 shader-f16
    const definitelyNoF16 = gpu.available && gpu.hasF16 === false && !!gpu.info;
    const recommendedKey = definitelyNoF16 ? 'compat' : 'standard';

    // risky 档（plus / minicpm）只对"大致够格"的设备开放：桌面端、f16 可用、
    // （能读到的）内存 >= 8GB、GPU 缓冲上限装得下对应的权重大文件。
    // 够格 != 安全，UI 上仍要标注风险。
    const maxBuf = (gpu.limits && gpu.limits.maxBufferSize) || 0;
    const riskyAllowed = (t) => !mobile && !definitelyNoF16
        && (deviceMemoryGB === null || deviceMemoryGB >= 8)
        && (maxBuf === 0 || maxBuf >= t.minBufferMB * 1024 * 1024);

    const tiers = TIER_ORDER.map((key) => {
        const t = MODEL_TIERS[key];
        const allowed = t.risky ? riskyAllowed(t) : (t.needsF16 ? !definitelyNoF16 : true);
        let note = '';
        if (t.risky) {
            note = allowed ? '⚠️ 有内存不足导致浏览器崩溃的风险，永远不会被自动推荐' : '当前设备不够格（手机 / 无 f16 / 内存或显存上限偏小），已隐藏';
        } else if (t.needsF16 && definitelyNoF16) {
            note = '当前显卡不支持 shader-f16，无法使用这一档';
        }
        return Object.assign({}, t, {
            allowed,
            recommended: key === recommendedKey,
            note
        });
    });

    return {
        usable: true,
        blockedReason: null,
        gpu, deviceMemoryGB,
        recommendedKey,
        savedKey: getSavedTierKey(),
        tiers
    };
}

// 清理浏览器里已下载的模型缓存文件（释放存储空间，或者用来强制重新下载）。
// 优先用 Transformers.js 自带的 ModelRegistry.clear_pipeline_cache()（会自动
// 识别这个模型/dtype 实际用到了哪些文件）；如果这个 CDN 版本没有导出
// ModelRegistry，就退回到直接操作 Cache Storage，按 URL 里是否包含 MODEL_ID
// 来筛选删除，尽量不影响这个站点可能存在的其它缓存内容。
//
// 清理完成后会：重置本模块里正在使用的 pipeline 引用（下次调用会重新走一遍
// 加载流程），并清掉 localStorage 里的"已加载过"标记（其它页面的 AI 辅助
// 生成入口会随之隐藏，直到重新加载模型）。
export async function clearAIModelCache() {
    let totalDeleted = 0;
    let registryWorked = false;

    // 逐档清理：每一档是独立的 modelId+dtype 组合，都要清到
    try {
        const mod = await import(TRANSFORMERS_CDN_URL);
        if (mod.ModelRegistry && typeof mod.ModelRegistry.clear_pipeline_cache === 'function') {
            for (const tier of Object.values(MODEL_TIERS)) {
                try {
                    const r = await mod.ModelRegistry.clear_pipeline_cache('text-generation', tier.modelId, { dtype: tier.dtype });
                    if (r && typeof r.filesDeleted === 'number') totalDeleted += r.filesDeleted;
                    registryWorked = true;
                } catch (e) {
                    console.warn(`清理 ${tier.modelId} (${tier.dtype}) 缓存失败：`, e);
                }
            }
        }
    } catch (e) {
        console.warn('通过 ModelRegistry 清理缓存失败，尝试直接清理 Cache Storage：', e);
    }

    if (!registryWorked && typeof caches !== 'undefined') {
        try {
            const modelIds = [...new Set(Object.values(MODEL_TIERS).map(t => t.modelId))];
            const cache = await caches.open('transformers-cache');
            const requests = await cache.keys();
            for (const req of requests) {
                if (modelIds.some(id => req.url.includes(id))) {
                    await cache.delete(req);
                    totalDeleted++;
                }
            }
        } catch (e) {
            console.warn('直接清理 Cache Storage 也失败了：', e);
        }
    }

    generatorPromise = null;
    activeTierKey = null;
    clearLoadedFlag();
    try { localStorage.removeItem(TIER_PREF_KEY); } catch (e) { /* 忽略 */ }

    return { filesDeleted: totalDeleted };
}

// ===== 本地模型管理（定向查看/清理某一档的缓存） =====
//
// Transformers.js 的浏览器缓存放在 Cache Storage 的 'transformers-cache' 里，
// URL 即模型仓库文件路径。注意 standard 和 compat 两档共用同一个模型仓库
// （只是 onnx 权重文件不同：model_q4f16.onnx vs model_q4.onnx），所以：
//   - 判断"某档是否已下载"看它专属的权重文件在不在缓存里
//   - 删除某档时只删它专属的权重文件；tokenizer/config 等共享小文件（几 MB）
//     只有当同仓库再没有其它档的权重时才一并删掉
// 文件大小从缓存响应的 content-length 头读取，避免把上 GB 的文件读进内存。

function tierWeightMarker(tier) {
    return `model_${tier.dtype}.onnx`; // 也能匹配到 model_xxx.onnx_data 分片
}

// 返回 [{key, label, dtype, downloadMB, cached, sizeBytes, fileCount}]，按 TIER_ORDER 排序。
// 浏览器不支持 Cache Storage 时返回空数组。
export async function listDownloadedModels() {
    if (typeof caches === 'undefined') return [];

    let requests;
    let cache;
    try {
        cache = await caches.open('transformers-cache');
        requests = await cache.keys();
    } catch (e) {
        console.warn('读取模型缓存列表失败：', e);
        return [];
    }

    const result = [];
    for (const key of TIER_ORDER) {
        const tier = MODEL_TIERS[key];
        const repoFiles = requests.filter(r => r.url.includes(tier.modelId));
        const weightFiles = repoFiles.filter(r => r.url.includes(tierWeightMarker(tier)));
        const sharedFiles = repoFiles.filter(r => !/model_[a-z0-9]+\.onnx/.test(r.url));

        if (!weightFiles.length) {
            result.push({ key, label: tier.label, dtype: tier.dtype, downloadMB: tier.downloadMB, cached: false, sizeBytes: 0, fileCount: 0 });
            continue;
        }

        let sizeBytes = 0;
        for (const req of [...weightFiles, ...sharedFiles]) {
            try {
                const resp = await cache.match(req);
                const len = resp && resp.headers.get('content-length');
                if (len) sizeBytes += parseInt(len, 10);
            } catch (e) { /* 单个文件读不到大小不影响整体 */ }
        }
        result.push({
            key, label: tier.label, dtype: tier.dtype, downloadMB: tier.downloadMB,
            cached: true, sizeBytes, fileCount: weightFiles.length + sharedFiles.length
        });
    }
    return result;
}

// 定向删除某一档的缓存文件。返回 {filesDeleted}。
export async function deleteDownloadedModel(tierKey) {
    const tier = MODEL_TIERS[tierKey];
    if (!tier) throw new Error(`未知的模型档位: ${tierKey}`);
    if (typeof caches === 'undefined') return { filesDeleted: 0 };

    const cache = await caches.open('transformers-cache');
    const requests = await cache.keys();
    let filesDeleted = 0;

    // 1. 删这一档专属的权重文件
    for (const req of requests) {
        if (req.url.includes(tier.modelId) && req.url.includes(tierWeightMarker(tier))) {
            await cache.delete(req);
            filesDeleted++;
        }
    }

    // 2. 同仓库如果再没有其它档的权重文件，把共享的 tokenizer/config 等小文件也删掉
    const remaining = await cache.keys();
    const otherWeightsExist = Object.values(MODEL_TIERS).some(t =>
        t.key !== tier.key && t.modelId === tier.modelId &&
        remaining.some(r => r.url.includes(t.modelId) && r.url.includes(tierWeightMarker(t)))
    );
    if (!otherWeightsExist) {
        for (const req of remaining) {
            if (req.url.includes(tier.modelId)) {
                await cache.delete(req);
                filesDeleted++;
            }
        }
    }

    // 3. 收尾：如果删的是"记住的档位"，清掉记忆（下次回到自动推荐）；
    //    如果所有档都没了，连"加载过"的标记也清掉（各页面的 AI 入口随之隐藏）。
    //    注意：不动 generatorPromise——已经加载进显存的模型还能继续用，删的只是磁盘缓存。
    if (getSavedTierKey() === tierKey) {
        try { localStorage.removeItem(TIER_PREF_KEY); } catch (e) { /* 忽略 */ }
    }
    const anyCached = (await listDownloadedModels()).some(m => m.cached);
    if (!anyCached && !generatorPromise) clearLoadedFlag();

    return { filesDeleted };
}

// 当前页面这次会话中，模型是否已经加载完成（区别于"之前是否加载过"）。
export function isModelReadyInThisPage() {
    return generatorPromise !== null;
}

// 加载前的显卡预检：把"detectGPUAdapter() 的诚实检测结论"真正用到加载决策上，
// 而不是像以前那样只用来显示提示、加载时却无条件强上 webgpu。
//
// 这个模型用的 4bit 量化格式主要依赖 WebGPU 加速、没有实用的 CPU 路径，所以"能不能
// 跑"基本等价于"有没有一块真实的 WebGPU 显卡"——以前那条 device: 'wasm' 的 fallback
// 分支对这个模型其实是死路。这里对确定跑不了的情况直接抛一个说明清楚的错误（会被页面
// 的 try/catch 接住、显示成友好提示），把"闷头冲进去然后浏览器崩溃"提前变成"加载前就
// 明确拒绝"。另外 q4f16 还需要 GPU 支持 shader-f16 特性，不支持时也在这里提前拦下。
//
// 注意：真实独立/集成显卡能通过这一关，但仍可能在真正分配显存时因显存不足而让
// GPU 进程崩溃（Mac 上一些 Chrome/Metal 组合比较常见）。那种崩溃发生在更底层、
// 抛不到 JS 层，这里无法完全预防，只能靠页面的"崩溃看门狗"事后提示用户。
async function preflightWebGPU(tier) {
    const gpu = await detectGPUAdapter();

    // 检测超时：结果不确定（手机浏览器上偶发），不硬性拦截，放行让它自己尝试。
    if (gpu.timedOut) return;

    if (!gpu.available) {
        throw new Error(
            '未检测到可用的 WebGPU 显卡。这个模型用的 4bit 量化格式主要依赖显卡(WebGPU)加速、' +
            '没有实用的 CPU 版本，因此没有可用显卡时无法加载。请换用支持 WebGPU 且有可用显卡的较新 Chrome / Edge 浏览器。'
        );
    }

    if (gpu.isFallback) {
        throw new Error(
            '检测到的 WebGPU 适配器是软件模拟（并非真实显卡加速），用它加载这个模型会极慢、' +
            '而且很可能直接让浏览器崩溃，已阻止加载。请在有真实显卡加速的设备/浏览器上再试。'
        );
    }

    // f16 档需要 GPU 支持 shader-f16。hasF16 明确为 false（即成功读到了适配器特性、
    // 但其中没有 shader-f16）时才拦截；读不到特性列表的老浏览器不误伤，放行让它自己
    // 尝试。不支持 f16 时会提示改用兼容版（compat 档）。
    if (tier.needsF16 && gpu.hasF16 === false && gpu.info) {
        throw new Error(
            '当前显卡/浏览器不支持 shader-f16（fp16）特性，无法加载这个 q4f16 量化模型。' +
            '请改选"兼容版"模型（无需 fp16），或更新到较新版本的 Chrome / Edge 后再试。'
        );
    }
    // 通过全部检查：放行。显存不足导致的崩溃无法在这一层预防（见上方说明）。
}

// 加载（或复用）text-generation pipeline。多次调用会复用同一个 Promise，
// 不会重复触发下载/初始化。progressCallback 可选，用于展示下载进度。
//
// tierKey 可选：不传时自动决定——优先用上次成功加载过的档位（保证整站一致、
// 命中缓存），否则用 getModelPlan() 的自动推荐。注意：同一个页面会话里模型
// 已经在加载/加载完成后，再传入不同的 tierKey 不会重新加载（需先刷新页面或
// 清理缓存），此时会在控制台给出警告。
export async function loadAIModel(progressCallback, tierKey) {
    if (generatorPromise) {
        if (tierKey && activeTierKey && tierKey !== activeTierKey) {
            console.warn(`模型已按 "${activeTierKey}" 档加载，忽略本次的 "${tierKey}"；如需换档请先刷新页面。`);
        }
        return generatorPromise;
    }

    generatorPromise = (async () => {
        let key = tierKey && MODEL_TIERS[tierKey] ? tierKey : getSavedTierKey();
        if (!key) {
            const plan = await getModelPlan();
            key = plan.recommendedKey || 'standard';
        }
        const tier = MODEL_TIERS[key];
        activeTierKey = key;

        await preflightWebGPU(tier); // 确定跑不了的设备在这里就会抛错，不再强上 webgpu
        const { pipeline } = await import(TRANSFORMERS_CDN_URL);
        const generator = await pipeline('text-generation', tier.modelId, {
            dtype: tier.dtype,
            device: 'webgpu', // 预检已保证有真实 WebGPU 适配器
            progress_callback: progressCallback
        });
        markModelLoaded();
        saveTierKey(key); // 只记住"成功加载过"的档位
        return generator;
    })();

    try {
        return await generatorPromise;
    } catch (err) {
        generatorPromise = null; // 加载失败时允许重新触发加载
        activeTierKey = null;
        throw err;
    }
}

// 当前页面实际加载（或正在加载）的档位 key；还没开始加载时返回 null。
export function getActiveTierKey() {
    return activeTierKey;
}

function extractText(result) {
    const gt = result && result[0] && result[0].generated_text;
    if (Array.isArray(gt)) {
        const last = gt[gt.length - 1];
        return (last && last.content) || '';
    }
    if (typeof gt === 'string') return gt;
    return '';
}

function cleanGeneratedText(text) {
    if (!text) return '';
    // 生成结果里遇到任一结束标记就截断（Qwen/MiniCPM 的对话结束符是 <|im_end|>，
    // 底模的通用结束符是 <|endoftext|> / </s>），只保留结束标记之前的正文。
    for (const marker of ['<|im_end|>', '<|endoftext|>', '</s>']) {
        const idx = text.indexOf(marker);
        if (idx !== -1) text = text.slice(0, idx);
    }
    // MiniCPM5 即便在 /no_think 模式下也可能输出（空的）思考段，去掉 <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    return text.trim();
}

// MiniCPM5 默认会走"深度思考"模式（回复前有一长段推理过程），在浏览器端会明显更慢、
// 更耗 token。官方用法是在用户消息末尾加 /no_think 切换到"快速回答"模式；除非用户
// 自己写了 /think 或 /no_think，否则默认帮忙追加 /no_think。只对 minicpm 档生效。
function withNoThinkDefault(messages) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== 'user') return messages;
    if (/\/(no_)?think\s*$/i.test((last.content || '').trim())) return messages;

    const copy = messages.slice();
    copy[lastIndex] = Object.assign({}, last, { content: last.content + ' /no_think' });
    return copy;
}

// 用 messages（[{role, content}, ...]）调用模型生成一段文本，返回纯文本结果。
// 如果模型在当前页面还没加载过，会自动先加载（这一步可能需要等待下载/初始化）。
//
// 流式输出：在 options 里传入 onToken(chunk) 回调，就会在生成过程中逐段把新生成的
// 文本片段回调出去（基于 Transformers.js 的 TextStreamer），方便页面"边生成边显示"，
// 显著改善慢设备上"长时间只显示正在思考"的观感。onToken 只是额外通知，函数最终仍会
// 返回清理后的完整文本；onToken 不会被当作生成参数传给模型。
export async function generateWithAI(messages, options, progressCallback) {
    const generator = await loadAIModel(progressCallback);

    // MiniCPM5 档默认关闭"深度思考"模式（Qwen 档没有这个概念，原样传入）
    if (activeTierKey === 'minicpm') {
        messages = withNoThinkDefault(messages);
    }

    // 把 onToken 从生成参数里摘出来，避免它被当成模型的 generation option 传下去。
    const opts = Object.assign({}, options || {});
    const onToken = opts.onToken;
    delete opts.onToken;

    let streamer = null;
    if (typeof onToken === 'function') {
        const { TextStreamer } = await import(TRANSFORMERS_CDN_URL); // 已缓存，不会重复下载
        streamer = new TextStreamer(generator.tokenizer, {
            skip_prompt: true,          // 不回显输入的 prompt，只吐新生成的内容
            skip_special_tokens: true,  // 过滤掉 <|im_end|> 等特殊标记
            callback_function: (text) => { if (text) onToken(text); }
        });
    }

    // 关键：直接把 messages 数组交给 pipeline，让它用分词器自带的官方 chat_template
    // 完成"套模板 + 特殊标记(<|im_start|>/<|im_end|>)正确分词"这一整套流程。之前手动
    // 拼接字符串再喂进去，特殊标记没有被当成真正的角色分隔符，模型识别不出"助手该
    // 从这里开始回答"，于是照抄 system 提示并陷入复读——换成原生 chat 路径即可解决。
    //
    // 生成参数：小模型（0.5B+q4）容易复读，用略低的温度 + repetition_penalty 抑制。
    // 注意不要用 no_repeat_ngram_size：它会硬性禁止任何 n-gram 重复，一旦"安全"的
    // 续写被禁光，模型会被逼到低概率的乱码 token 上（诗歌那次的乱码就是这么来的）。
    const genOptions = Object.assign({
        max_new_tokens: 220,
        do_sample: true,
        temperature: 0.6,
        top_p: 0.9,
        top_k: 40,
        repetition_penalty: 1.2
    }, opts);
    if (streamer) genOptions.streamer = streamer;

    const result = await generator(messages, genOptions);

    return cleanGeneratedText(extractText(result));
}

