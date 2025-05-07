/*
 * @Author: AI
 * @Date: 2025-05-02 15:10:00
 * @Description: ASR消息分发器 - 处理语音识别结果的分发
 */
import settings from '../../settings.js';

/**
 * ASR消息分发器
 * 负责将ASR语音识别结果分发给一个或多个Agent
 */
class ASRDispatcher {
    constructor() {
        // 单例模式
        if (ASRDispatcher.instance) {
            return ASRDispatcher.instance;
        }
        
        this.messageHandlers = []; // 存储所有已注册的消息处理函数
        this.agentNames = [];      // 存储所有已注册Agent的名称
        this.debug = process.env.NODE_ENV === 'development' || settings.asr_debug;
        
        ASRDispatcher.instance = this;
    }
    
    /**
     * 注册一个新的Agent到分发器
     * @param {string} agentName - Agent的名称
     * @param {Function} messageHandler - Agent的消息处理函数
     * @returns {number} - 注册的处理函数索引
     */
    register(agentName, messageHandler) {
        if (!agentName || typeof messageHandler !== 'function') {
            console.error('ASRDispatcher: 无效的Agent名称或消息处理函数');
            return -1;
        }
        
        // 检查是否已注册相同的Agent
        const existingIndex = this.agentNames.indexOf(agentName);
        if (existingIndex !== -1) {
            if (this.debug) {
                console.log(`ASRDispatcher: Agent "${agentName}" 已存在，更新处理函数`);
            }
            // 更新现有Agent的处理函数
            this.messageHandlers[existingIndex] = messageHandler;
            return existingIndex;
        }
        
        // 注册新Agent
        const index = this.messageHandlers.length;
        this.messageHandlers.push(messageHandler);
        this.agentNames.push(agentName);
        
        if (this.debug) {
            console.log(`ASRDispatcher: 注册Agent "${agentName}", 总Agent数: ${this.agentNames.length}`);
        }
        
        return index;
    }
    
    /**
     * 从分发器中移除一个Agent
     * @param {string} agentName - 要移除的Agent名称
     * @returns {boolean} - 是否成功移除
     */
    unregister(agentName) {
        const index = this.agentNames.indexOf(agentName);
        if (index === -1) {
            if (this.debug) {
                console.warn(`ASRDispatcher: 尝试移除不存在的Agent "${agentName}"`);
            }
            return false;
        }
        
        // 移除Agent
        this.agentNames.splice(index, 1);
        this.messageHandlers.splice(index, 1);
        
        if (this.debug) {
            console.log(`ASRDispatcher: 已移除Agent "${agentName}", 剩余Agent数: ${this.agentNames.length}`);
        }
        
        return true;
    }
    
    /**
     * 处理并分发ASR识别结果
     * @param {string} sender - 消息发送者(通常是settings.player_name)
     * @param {string} message - ASR识别到的文本消息
     */
    dispatch(sender, message) {
        if (!message || !message.trim()) {
            if (this.debug) {
                console.warn('ASRDispatcher: 收到空消息，忽略');
            }
            return;
        }
        
        if (this.messageHandlers.length === 0) {
            console.warn('ASRDispatcher: 没有注册的Agent，无法分发消息');
            return;
        }
        
        if (this.debug) {
            console.log(`ASRDispatcher: 收到消息 - "${message}"`);
        }
        
        // 尝试提取消息前缀中的Agent名称
        const targetAgent = this.extractTargetAgent(message);
        
        if (targetAgent) {
            // 找到特定目标，只分发给指定的Agent
            const agentIndex = this.agentNames.indexOf(targetAgent.name);
            if (agentIndex !== -1) {
                if (this.debug) {
                    console.log(`ASRDispatcher: 将消息分发给指定Agent "${targetAgent.name}"`);
                }
                // 去掉消息前缀的Agent名称
                const cleanMessage = targetAgent.restMessage.trim();
                this.messageHandlers[agentIndex](sender, cleanMessage);
            } else {
                console.warn(`ASRDispatcher: 找不到名为 "${targetAgent.name}" 的Agent，执行广播`);
                this.broadcastMessage(sender, message);
            }
        } else {
            // 没有指定目标，广播给所有Agent
            this.broadcastMessage(sender, message);
        }
    }
    
    /**
     * 从消息中提取目标Agent名称
     * @param {string} message - 原始消息
     * @returns {Object|null} - 包含目标Agent名称和剩余消息的对象，或null表示无目标
     */
    extractTargetAgent(message) {
        // 如果没有注册Agent，直接返回null
        if (this.agentNames.length === 0) return null;
        
        // 尝试匹配消息开头是否包含Agent名称
        for (const agentName of this.agentNames) {
            // 检查消息是否以Agent名称开头，后跟标点符号、空格或逗号
            const patterns = [
                new RegExp(`^${agentName}[,，:：、。！？!?\\s]+(.+)$`, 'i'),  // 带标点
                new RegExp(`^${agentName}\\s+(.+)$`, 'i'),                    // 只有空格
                new RegExp(`^${agentName}$`, 'i')                             // 只有名字
            ];
            
            for (const pattern of patterns) {
                const match = message.match(pattern);
                if (match) {
                    return {
                        name: agentName,
                        restMessage: match[1] || ""  // 如果是只有名字，restMessage为空字符串
                    };
                }
            }
        }
        
        return null; // 没有找到匹配的Agent名称
    }
    
    /**
     * 广播消息给所有注册的Agent
     * @param {string} sender - 消息发送者
     * @param {string} message - 消息内容
     */
    broadcastMessage(sender, message) {
        if (this.debug) {
            console.log(`ASRDispatcher: 广播消息给所有Agent (${this.agentNames.length}个)`);
        }
        
        for (let i = 0; i < this.messageHandlers.length; i++) {
            try {
                this.messageHandlers[i](sender, message);
            } catch (error) {
                console.error(`ASRDispatcher: 调用Agent "${this.agentNames[i]}" 的处理函数时出错:`, error);
            }
        }
    }
}

// 创建并导出单例
const asrDispatcher = new ASRDispatcher();
export default asrDispatcher; 