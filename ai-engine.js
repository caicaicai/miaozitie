// 喵字帖 - AI 内容生成共享引擎（实验性功能）
//
// 基于 Transformers.js + MiniCPM5-1B，模型完全在浏览器本地运行，不经过任何服务器。
// 各功能页面（如 tingxie.html、moxie.html）可以 import 这个模块，复用模型加载与
// 生成逻辑，并通过 hasModelBeenLoadedBefore() 判断是否要展示"AI 辅助生成"界面。
//
// 注意：localStorage 标记只表示"这个浏览器之前成功加载过一次"，用来推测这次加载
// 大概率会很快（模型文件已被浏览器缓存），而不是精确判断缓存是否仍然有效——
// 就算标记存在，真正调用生成时仍可能触发一次下载（例如用户清理过浏览器数据）。

const MODEL_ID = 'Mike0021/MiniCPM5-1B-ONNX-Web';
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const READY_FLAG_KEY = 'miaozitie_ai_model_ready';

let generatorPromise = null;

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
export async function detectGPUAdapter() {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        return { available: false, isFallback: false, info: null, timedOut: false };
    }

    const detect = (async () => {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return { available: false, isFallback: false, info: null, timedOut: false };
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
            return { available: true, isFallback, info, timedOut: false };
        } catch (e) {
            return { available: false, isFallback: false, info: null, timedOut: false };
        }
    })();

    return withTimeout(detect, 4000, { available: false, isFallback: false, info: null, timedOut: true });
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
    let result = null;

    try {
        const mod = await import(TRANSFORMERS_CDN_URL);
        if (mod.ModelRegistry && typeof mod.ModelRegistry.clear_pipeline_cache === 'function') {
            result = await mod.ModelRegistry.clear_pipeline_cache('text-generation', MODEL_ID, { dtype: 'q4' });
        }
    } catch (e) {
        console.warn('通过 ModelRegistry 清理缓存失败，尝试直接清理 Cache Storage：', e);
    }

    if (!result && typeof caches !== 'undefined') {
        try {
            const cache = await caches.open('transformers-cache');
            const requests = await cache.keys();
            let filesDeleted = 0;
            for (const req of requests) {
                if (req.url.includes(MODEL_ID)) {
                    await cache.delete(req);
                    filesDeleted++;
                }
            }
            result = { filesDeleted };
        } catch (e) {
            console.warn('直接清理 Cache Storage 也失败了：', e);
        }
    }

    generatorPromise = null;
    clearLoadedFlag();

    return result || { filesDeleted: 0 };
}

// 当前页面这次会话中，模型是否已经加载完成（区别于"之前是否加载过"）。
export function isModelReadyInThisPage() {
    return generatorPromise !== null;
}

// 加载（或复用）text-generation pipeline。多次调用会复用同一个 Promise，
// 不会重复触发下载/初始化。progressCallback 可选，用于展示下载进度。
export async function loadAIModel(progressCallback) {
    if (generatorPromise) return generatorPromise;

    generatorPromise = (async () => {
        const { pipeline } = await import(TRANSFORMERS_CDN_URL);
        const device = supportsWebGPU() ? 'webgpu' : 'wasm';
        const generator = await pipeline('text-generation', MODEL_ID, {
            dtype: 'q4',
            device,
            progress_callback: progressCallback
        });
        markModelLoaded();
        return generator;
    })();

    try {
        return await generatorPromise;
    } catch (err) {
        generatorPromise = null; // 加载失败时允许重新触发加载
        throw err;
    }
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

// 这个社区 ONNX 导出版本的 tokenizer_config.json 没有带 chat_template，
// 直接把 messages 数组传给 pipeline 会报错（apply_chat_template 失败）。
// 所以这里改成手动按 MiniCPM5 官方的 ChatML 格式拼接成一段纯文本 prompt，
// 绕开 apply_chat_template，不依赖这个导出版本是否配置完整。
function formatChatPrompt(messages) {
    let prompt = '';
    messages.forEach(m => {
        const role = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
        prompt += `<|im_start|>${role}\n${m.content}<|im_end|>\n`;
    });
    prompt += '<|im_start|>assistant\n';
    return prompt;
}

// MiniCPM5 默认会走"深度思考"模式（回复前有一长段推理过程），在浏览器端会明显更慢、
// 更耗 token。除非用户自己在消息末尾写了 /think 或 /no_think，否则默认追加
// /no_think 强制走"快速回答"模式，详见官方文档中 enable_thinking 的说明。
function withNoThinkDefault(messages) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== 'user') return messages;
    if (/\/(no_)?think\s*$/i.test(last.content.trim())) return messages;

    const copy = messages.slice();
    copy[lastIndex] = Object.assign({}, last, { content: last.content + ' /no_think' });
    return copy;
}

function cleanGeneratedText(text) {
    if (!text) return '';
    const endIdx = text.indexOf('<|im_end|>');
    if (endIdx !== -1) {
        text = text.slice(0, endIdx);
    }
    return text.trim();
}

// 用 messages（[{role, content}, ...]）调用模型生成一段文本，返回纯文本结果。
// 如果模型在当前页面还没加载过，会自动先加载（这一步可能需要等待下载/初始化）。
export async function generateWithAI(messages, options, progressCallback) {
    const generator = await loadAIModel(progressCallback);
    const prompt = formatChatPrompt(withNoThinkDefault(messages));

    const result = await generator(prompt, Object.assign({
        max_new_tokens: 220,
        temperature: 0.7,
        do_sample: true,
        repetition_penalty: 1.1,
        return_full_text: false
    }, options || {}));

    return cleanGeneratedText(extractText(result));
}

export const AI_MODEL_ID = MODEL_ID;
