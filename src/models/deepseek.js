/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-05 21:35:59
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-05-13 11:47:18
 * @FilePath: /mindcraft/src/models/deepseek.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { recordTokenUsage, estimateTokenCount } from '../utils/token_stats.js';

export class DeepSeek {
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;

        let config = {};

        config.baseURL = url || 'https://api.deepseek.com';
        config.apiKey = getKey('DEEPSEEK_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', agentName = '', toolsNum = 0) {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);

        messages = strictFormat(messages);

        const pack = {
            model: this.model_name || "deepseek-chat",
            messages,
            stop: stop_seq,
            ...(this.params || {})
        };

        let res = null;
        try {
            console.log('Awaiting deepseek api response...')
            // console.log('Messages:', messages);
            let completion = await this.openai.chat.completions.create(pack);
            
            // 获取用户消息和系统消息
            let userMessage = '';
            if (turns.length > 0 && turns[turns.length - 1].role === 'user') {
                userMessage = turns[turns.length - 1].content;
            }
            
            // 记录token使用情况
            if (completion.usage) {
                recordTokenUsage(
                    this.model_name || "deepseek-chat",
                    completion.usage.prompt_tokens,
                    completion.usage.completion_tokens,
                    'deepseek',
                    agentName,
                    userMessage,
                    systemMessage,
                    toolsNum,
                    completion.choices[0].message.content
                );
            } else {
                // 如果API未返回token使用信息，使用估算器
                const promptText = systemMessage + JSON.stringify(messages);
                const promptTokens = estimateTokenCount(promptText);
                const completionTokens = estimateTokenCount(completion.choices[0].message.content);
                
                recordTokenUsage(
                    this.model_name || "deepseek-chat",
                    promptTokens,
                    completionTokens,
                    'deepseek',
                    agentName,
                    userMessage,
                    systemMessage,
                    toolsNum,
                    completion.choices[0].message.content
                );
            }
            
            if (completion.choices[0].finish_reason == 'length')
                throw new Error('Context length exceeded'); 
            console.log('Received.')
            res = completion.choices[0].message.content;
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else if (err.code === 'insufficient_quota' || err.status === 402 || 
                      err.message.includes('quota') || err.message.includes('Access denied') || 
                      err.message.includes('account is in good standing')) {
                // 处理账户欠费或状态异常
                console.error('DeepSeek API账户状态异常:', err);
                res = 'DeepSeek API账户出现欠费或状态异常，请检查账户。错误信息: ' + err.message;
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Deepseek.');
    }
}



