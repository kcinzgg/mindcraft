import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../../settings.js';

import { Gemini } from './gemini.js';
import { GPT } from './gpt.js';
import { Claude } from './claude.js';
import { Mistral } from './mistral.js';
import { ReplicateAPI } from './replicate.js';
import { Local } from './local.js';
import { Novita } from './novita.js';
import { GroqCloudAPI } from './groq.js';
import { HuggingFace } from './huggingface.js';
import { Qwen } from "./qwen.js";
import { Grok } from "./grok.js";
import { DeepSeek } from './deepseek.js';
import { Doubao } from './doubao.js';
import { Hyperbolic } from './hyperbolic.js';
import { GLHF } from './glhf.js';
import { OpenRouter } from './openrouter.js';

export class Prompter {
    constructor(agent, fp) {
        this.agent = agent;
        this.profile = JSON.parse(readFileSync(fp, 'utf8'));
        let default_profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        let base_fp = settings.base_profile;
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // try to get "max_tokens" parameter, else null
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = this._selectAPI(this.profile.model);
        this.chat_model = this._createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = this._selectAPI(this.profile.code_model);
            this.code_model = this._createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = this._selectAPI(this.profile.vision_model);
            this.vision_model = this._createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        let embedding = this.profile.embedding;
        if (embedding === undefined) {
            if (chat_model_profile.api !== 'ollama')
                embedding = {api: chat_model_profile.api};
            else
                embedding = {api: 'none'};
        }
        else if (typeof embedding === 'string' || embedding instanceof String)
            embedding = {api: embedding};

        console.log('Using embedding settings:', embedding);

        try {
            if (embedding.api === 'google')
                this.embedding_model = new Gemini(embedding.model, embedding.url);
            else if (embedding.api === 'openai')
                this.embedding_model = new GPT(embedding.model, embedding.url);
            else if (embedding.api === 'replicate')
                this.embedding_model = new ReplicateAPI(embedding.model, embedding.url);
            else if (embedding.api === 'ollama')
                this.embedding_model = new Local(embedding.model, embedding.url);
            else if (embedding.api === 'qwen')
                this.embedding_model = new Qwen(embedding.model, embedding.url);
            else if (embedding.api === 'doubao')
                this.embedding_model = new Doubao(embedding.model, embedding.url);
            else if (embedding.api === 'mistral')
                this.embedding_model = new Mistral(embedding.model, embedding.url);
            else if (embedding.api === 'huggingface')
                this.embedding_model = new HuggingFace(embedding.model, embedding.url);
            else if (embedding.api === 'novita')
                this.embedding_model = new Novita(embedding.model, embedding.url);
            else {
                this.embedding_model = null;
                let embedding_name = embedding ? embedding.api : '[NOT SPECIFIED]'
                console.warn('Unsupported embedding: ' + embedding_name + '. Using word-overlap instead, expect reduced performance. Recommend using a supported embedding model. See Readme.');
            }
        }
        catch (err) {
            console.warn('Warning: Failed to initialize embedding model:', err.message);
            console.log('Continuing anyway, using word-overlap instead.');
            this.embedding_model = null;
        }
        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    _selectAPI(profile) {
        if (typeof profile === 'string' || profile instanceof String) {
            profile = {model: profile};
        }
        if (!profile.api) {
            if (profile.model.includes('openrouter/'))
                profile.api = 'openrouter'; // must do first because shares names with other models
            else if (profile.model.includes('ollama/'))
                profile.api = 'ollama'; // also must do early because shares names with other models
            else if (profile.model.includes('gemini'))
                profile.api = 'google';
            else if (profile.model.includes('gpt') || profile.model.includes('o1')|| profile.model.includes('o3'))
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('huggingface/'))
                profile.api = "huggingface";
            else if (profile.model.includes('replicate/'))
                profile.api = 'replicate';
            else if (profile.model.includes('mistralai/') || profile.model.includes("mistral/"))
                model_profile.api = 'mistral';
            else if (profile.model.includes("groq/") || profile.model.includes("groqcloud/"))
                profile.api = 'groq';
            else if (profile.model.includes("glhf/"))
                profile.api = 'glhf';
            else if (profile.model.includes("hyperbolic/"))
                profile.api = 'hyperbolic';
            else if (profile.model.includes('novita/'))
                profile.api = 'novita';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
            else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else if (profile.model.includes('doubao'))
                profile.api = 'doubao';
            else 
                throw new Error('Unknown model:', profile.model);
        }
        return profile;
    }
    _createModel(profile) {
        let model = null;
        if (profile.api === 'google')
            model = new Gemini(profile.model, profile.url, profile.params);
        else if (profile.api === 'openai')
            model = new GPT(profile.model, profile.url, profile.params);
        else if (profile.api === 'anthropic')
            model = new Claude(profile.model, profile.url, profile.params);
        else if (profile.api === 'replicate')
            model = new ReplicateAPI(profile.model.replace('replicate/', ''), profile.url, profile.params);
        else if (profile.api === 'ollama')
            model = new Local(profile.model.replace('ollama/', ''), profile.url, profile.params);
        else if (profile.api === 'mistral')
            model = new Mistral(profile.model, profile.url, profile.params);
        else if (profile.api === 'groq')
            model = new GroqCloudAPI(profile.model.replace('groq/', '').replace('groqcloud/', ''), profile.url, profile.params);
        else if (profile.api === 'huggingface')
            model = new HuggingFace(profile.model, profile.url, profile.params);
        else if (profile.api === 'glhf')
            model = new GLHF(profile.model.replace('glhf/', ''), profile.url, profile.params);
        else if (profile.api === 'hyperbolic')
            model = new Hyperbolic(profile.model.replace('hyperbolic/', ''), profile.url, profile.params);
        else if (profile.api === 'novita')
            model = new Novita(profile.model.replace('novita/', ''), profile.url, profile.params);
        else if (profile.api === 'qwen')
            model = new Qwen(profile.model, profile.url, profile.params);
        else if (profile.api === 'xai')
            model = new Grok(profile.model, profile.url, profile.params);
        else if (profile.api === 'deepseek')
            model = new DeepSeek(profile.model, profile.url, profile.params);
        else if (profile.api === 'openrouter')
            model = new OpenRouter(profile.model.replace('openrouter/', ''), profile.url, profile.params);
        else if (profile.api === 'doubao')
            model = new Doubao(profile.model, profile.url, profile.params);
        else
            throw new Error('Unknown API:', profile.api);
        return model;
    }
    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs());
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, this.cooldown - elapsed));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;
        
        // 尝试使用主模型
        try {
            for (let i = 0; i < 3; i++) { // try 3 times to avoid hallucinations
                await this.checkCooldown();
                if (current_msg_time !== this.most_recent_msg_time) {
                    return '';
                }
                let prompt = this.profile.conversing;
                prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
                
                try {
                    // 计算工具调用数量
                    let toolsNum = 0;
                    for (const msg of messages) {
                        if (msg.content && typeof msg.content === 'string') {
                            // 简单统计潜在的工具调用（只是粗略估计）
                            const toolMatches = msg.content.match(/!([\w]+)/g);
                            if (toolMatches) {
                                toolsNum += toolMatches.length;
                            }
                        }
                    }
                    
                    // 调用模型API时传递Agent信息
                    let generation = await this.chat_model.sendRequest(
                        messages, 
                        prompt, 
                        undefined, // 使用默认stop_seq
                        this.agent.name,
                        toolsNum
                    );
                    
                    // in conversations >2 players LLMs tend to hallucinate and role-play as other bots
                    // the FROM OTHER BOT tag should never be generated by the LLM
                    if (generation.includes('(FROM OTHER BOT)')) {
                        console.warn('LLM hallucinated message as another bot. Trying again...');
                        continue;
                    }
                    if (current_msg_time !== this.most_recent_msg_time) {
                        console.warn(this.agent.name + ' received new message while generating, discarding old response.');
                        return '';
                    }
                    return generation;
                } catch (err) {
                    // 检查是否是账户问题
                    if (err.code === 'Arrearage' || 
                        err.code === 'insufficient_quota' || 
                        err.status === 402 || 
                        (err.error && (err.error.code === 'Arrearage' || err.error.code === 'insufficient_quota')) || 
                        err.message.includes('Access denied') || 
                        err.message.includes('account is in good standing') ||
                        err.message.includes('quota')) {
                        
                        console.error('模型API账户状态异常，尝试使用备用模型:', err);
                        throw err; // 抛出错误以便使用备用模型
                    }
                    
                    // 其他错误，继续尝试
                    console.warn('模型调用出错，重试中:', err);
                    continue;
                }
            }
            return '';
        } catch (modelError) {
            // 主模型失败，尝试使用备用模型（如果有配置）
            console.warn('主模型调用失败，尝试使用备用模型');
            
            // 检查是否配置了备用模型
            let backupModelName = this.profile.backup_model || process.env.BACKUP_MODEL || "ollama/llama3";
            
            if (backupModelName) {
                try {
                    // 创建临时备用模型
                    let backupModelProfile = this._selectAPI(backupModelName);
                    let backupModel = this._createModel(backupModelProfile);
                    
                    // 使用备用模型
                    let prompt = this.profile.conversing;
                    prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
                    prompt = prompt + "\n\n注意：主模型暂时不可用，正在使用备用模型进行回复。";
                    
                    // 计算工具调用数量
                    let toolsNum = 0;
                    for (const msg of messages) {
                        if (msg.content && typeof msg.content === 'string') {
                            const toolMatches = msg.content.match(/!([\w]+)/g);
                            if (toolMatches) {
                                toolsNum += toolMatches.length;
                            }
                        }
                    }
                    
                    // 调用备用模型时传递Agent信息
                    let generation = await backupModel.sendRequest(
                        messages, 
                        prompt,
                        undefined,
                        this.agent.name,
                        toolsNum
                    );
                    
                    if (generation.includes('(FROM OTHER BOT)')) {
                        generation = generation.replace(/\(FROM OTHER BOT\)/g, '');
                    }
                    
                    // 添加备用模型提示
                    return generation + "\n\n[使用备用模型回复 - 主模型暂时不可用]";
                } catch (backupError) {
                    console.error('备用模型也失败了:', backupError);
                    return "对不起，主模型和备用模型都无法使用，请检查API账户状态。";
                }
            } else {
                return "对不起，模型API账户出现问题（可能是欠费），请检查账户状态。";
            }
        }
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);
        
        // 计算工具调用数量
        let toolsNum = 0;
        for (const msg of messages) {
            if (msg.content && typeof msg.content === 'string') {
                const toolMatches = msg.content.match(/!([\w]+)/g);
                if (toolMatches) {
                    toolsNum += toolMatches.length;
                }
            }
        }
        
        let resp = await this.code_model.sendRequest(
            messages, 
            prompt,
            undefined,
            this.agent.name,
            toolsNum
        );
        this.awaiting_coding = false;
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        return await this.chat_model.sendRequest(
            [], 
            prompt, 
            undefined, 
            this.agent.name, 
            0, // 内存摘要不涉及工具调用
        );
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest(
            [], 
            prompt, 
            undefined, 
            this.agent.name, 
            0, // 判断是否回复机器人不涉及工具调用
        );
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        
        // 从消息中提取用户的最后一条消息作为userMessage
        let userMessage = '';
        if (messages && messages.length > 0) {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === 'user') {
                    userMessage = messages[i].content;
                    break;
                }
            }
        }
        
        // 检查是否需要使用sendVisionRequest方法，如果不存在则降级使用sendRequest
        if (typeof this.vision_model.sendVisionRequest === 'function') {
            return await this.vision_model.sendVisionRequest(
                messages, 
                prompt, 
                imageBuffer,
                this.agent.name,
                0 // 图像分析一般不涉及工具调用
            );
        } else {
            // 如果没有专门的视觉请求方法，则使用普通的sendRequest
            return await this.vision_model.sendRequest(
                messages, 
                prompt, 
                undefined,
                this.agent.name,
                0 // 图像分析一般不涉及工具调用
            );
        }
    }

    async promptGoalSetting(messages, last_goals) {
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(
            user_messages, 
            system_message, 
            undefined, 
            this.agent.name, 
            0, // 目标设定不涉及工具调用
        );

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }
}
