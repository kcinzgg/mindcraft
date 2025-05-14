import Groq from 'groq-sdk'
import { getKey } from '../utils/keys.js';

// THIS API IS NOT TO BE CONFUSED WITH GROK!
// Go to grok.js for that. :)

// Umbrella class for everything under the sun... That GroqCloud provides, that is.
export class GroqCloudAPI {

    constructor(model_name, url, params) {

        this.model_name = model_name;
        this.url = url;
        this.params = params || {};

        // Remove any mention of "tools" from params:
        if (this.params.tools)
            delete this.params.tools;
        // This is just a bit of future-proofing in case we drag Mindcraft in that direction.

        // I'm going to do a sneaky ReplicateAPI theft for a lot of this, aren't I?
        if (this.url)
            console.warn("Groq Cloud has no implementation for custom URLs. Ignoring provided URL.");

        this.groq = new Groq({ apiKey: getKey('GROQCLOUD_API_KEY') });


    }

    async sendRequest(messages, systemMessage = undefined, agentName = '', toolsNum = 0) {
        let messagePayload;
        
        // 处理系统消息
        if (systemMessage) {
            messagePayload = [{ role: 'system', content: systemMessage }].concat(messages);
        } else {
            messagePayload = [...messages];
        }
        
        try {
            console.log('Awaiting Groq response...');
            const completionRequest = {
                model: this.model_name, 
                messages: messagePayload,
                ...(this.params || {})
            };
            
            const completion = await this.groq.chat.completions.create(completionRequest);
            console.log('Received.');
            
            // 记录token使用情况，如果API返回
            if (completion.usage && agentName) {
                const { recordTokenUsage } = await import('../utils/token_stats.js');
                recordTokenUsage(
                    this.model_name,
                    completion.usage.prompt_tokens || 0,
                    completion.usage.completion_tokens || 0,
                    'groq',
                    agentName,
                    messages.length > 0 ? (messages[messages.length-1].content || '') : '',
                    systemMessage || '',
                    toolsNum,
                    completion.choices[0].message.content
                );
            }
            
            return completion.choices[0].message.content;
        } catch (error) {
            console.log('Error from Groq:', error);
            if (error.message.includes('context_length_exceeded') && messages.length > 1) {
                return this.sendRequest(messages.slice(1), systemMessage, agentName, toolsNum);
            }
            return "My brain disconnected, try again.";
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer, agentName = '', toolsNum = 0) {
        const imageMessages = messages.filter(message => message.role !== 'system');
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, undefined, agentName, toolsNum);
    }

    async embed(_) {
        throw new Error('Embeddings are not supported by Groq.');
    }
}
