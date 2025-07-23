import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { recordTokenUsage, estimateTokenCount } from '../utils/token_stats.js';

export class Doubao {
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        let config = {};

        config.baseURL = url || '';
        config.apiKey = getKey('DOUBAO_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', agentName = '', toolsNum = 0) {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };

        let res = null;
        try {
            console.log('Awaiting Doubao api response...');
            // console.log('Messages:', messages);
            const startTime = new Date().getTime();
            let completion = await this.openai.chat.completions.create(pack);
            
            // 记录token使用情况
            if (completion.usage) {
                recordTokenUsage(
                    this.model_name || "Doubao-plus",
                    completion.usage.prompt_tokens,
                    completion.usage.completion_tokens,
                    'Doubao',
                    agentName,
                    messages, // 传入完整的messages数组
                    toolsNum,
                    { // 传入完整的completion响应信息
                        choices: completion.choices,
                        model: completion.model,
                        id: completion.id,
                        created: completion.created,
                        finish_reason: completion.choices[0]?.finish_reason,
                        message: completion.choices[0]?.message
                    },
                    { // 元数据
                        request_params: pack,
                        response_time_ms: new Date().getTime() - startTime,
                        api_endpoint: this.openai.baseURL
                    }
                );
            } else {
                // 如果API未返回token使用信息，使用估算器
                const promptTokens = estimateTokenCount(JSON.stringify(messages));
                const completionTokens = estimateTokenCount(completion.choices[0].message.content);
                
                recordTokenUsage(
                    this.model_name || "Doubao-plus",
                    promptTokens,
                    completionTokens,
                    'Doubao',
                    agentName,
                    messages, // 传入完整的messages数组
                    toolsNum,
                    { // 传入完整的completion响应信息
                        choices: completion.choices,
                        model: completion.model,
                        id: completion.id,
                        created: completion.created,
                        finish_reason: completion.choices[0]?.finish_reason,
                        message: completion.choices[0]?.message,
                        estimated_tokens: true
                    },
                    { // 元数据
                        request_params: pack,
                        response_time_ms: new Date().getTime() - startTime,
                        api_endpoint: this.openai.baseURL,
                        note: "Token usage estimated"
                    }
                );
            }
            
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded');
            console.log('Received.');
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else if (err.code === 'Arrearage' || (err.error && err.error.code === 'Arrearage') || 
                       err.message.includes('Access denied') || err.message.includes('account is in good standing')) {
                // 处理账户欠费或状态异常
                console.error('豆包API账户状态异常:', err);
                res = '豆包API账户出现欠费或状态异常，请检查火山云账户。错误信息: ' + err.message;
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    // Why random backoff?
    // With a 30 requests/second limit on Doubao's embedding service,
    // random backoff helps maximize bandwidth utilization.
    async embed(text, agentName = '') {
        const maxRetries = 5; // Maximum number of retries
        for (let retries = 0; retries < maxRetries; retries++) {
            try {
                const { data } = await this.openai.embeddings.create({
                    model: this.model_name || "text-embedding-v3",
                    input: text,
                    encoding_format: "float",
                });
                
                // 记录embedding的token使用量
                const promptTokens = data.usage?.prompt_tokens || estimateTokenCount(text);
                const inputText = text.substring(0, 100) + (text.length > 100 ? '...' : '');
                
                recordTokenUsage(
                    this.model_name || "text-embedding-v3",
                    promptTokens,
                    0, // embedding通常没有completion tokens
                    'Doubao',
                    agentName,
                    [{ role: 'user', content: inputText }], // 格式化为消息格式
                    0,
                    { // embedding响应信息
                        data: data.data?.length || 0,
                        model: data.model,
                        embedding_dimensions: data.data?.[0]?.embedding?.length || 0,
                        encoding_format: "float"
                    },
                    { // 元数据
                        operation: 'embedding',
                        original_text_length: text.length,
                        api_endpoint: this.openai.baseURL
                    }
                );
                
                return data[0].embedding;
            } catch (err) {
                if (err.status === 429) {
                    // If a rate limit error occurs, calculate the exponential backoff with a random delay (1-5 seconds)
                    const delay = Math.pow(2, retries) * 1000 + Math.floor(Math.random() * 2000);
                    // console.log(`Rate limit hit, retrying in ${delay} ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay)); // Wait for the delay before retrying
                } else if (err.code === 'Arrearage' || (err.error && err.error.code === 'Arrearage') || 
                          err.message.includes('Access denied') || err.message.includes('account is in good standing')) {
                    // 处理账户欠费或状态异常
                    console.error('豆包API账户状态异常:', err);
                    throw new Error('豆包API账户出现欠费或状态异常，请检查火山云账户');
                } else {
                    throw err;
                }
            }
        }
        // If maximum retries are reached and the request still fails, throw an error
        throw new Error('Max retries reached, request failed.');
    }

}