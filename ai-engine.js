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

// 用 messages（[{role, content}, ...]）调用模型生成一段文本，返回纯文本结果。
// 如果模型在当前页面还没加载过，会自动先加载（这一步可能需要等待下载/初始化）。
export async function generateWithAI(messages, options, progressCallback) {
    const generator = await loadAIModel(progressCallback);
    const result = await generator(messages, Object.assign({
        max_new_tokens: 220,
        temperature: 0.7,
        do_sample: true,
        repetition_penalty: 1.1
    }, options || {}));
    return extractText(result).trim();
}

export const AI_MODEL_ID = MODEL_ID;
