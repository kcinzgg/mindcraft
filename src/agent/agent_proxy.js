/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-05 21:35:59
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-04-30 18:10:13
 * @FilePath: /mindcraft/src/agent/agent_proxy.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import settings from '../../settings.js';

class AgentServerProxy {
    constructor() {
        if (AgentServerProxy.instance) {
            return AgentServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        AgentServerProxy.instance = this;
    }

    connect(agent) {
        if (this.connected) return;
        
        this.agent = agent;

        this.socket = io(`http://${settings.mindserver_host}:${settings.mindserver_port}`);
        this.connected = true;

        this.socket.on('connect', () => {
            console.log('Connected to MindServer');
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-update', (agents) => {
            convoManager.updateAgents(agents);
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
		this.socket.on('send-message', (agentName, message) => {
			try {
				this.agent.respondFunc("NO USERNAME", message);
			} catch (error) {
				console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
			}
		});
        
        // 添加ASR控制事件监听
        this.socket.on('start-asr', () => {
            try {
                const result = this.agent.startASR();
                this.socket.emit('asr-status', { active: result, message: result ? 'ASR started' : 'Failed to start ASR' });
            } catch (error) {
                console.error('Error starting ASR:', error);
                this.socket.emit('asr-status', { active: false, message: 'Error starting ASR' });
            }
        });
        
        this.socket.on('stop-asr', () => {
            try {
                const result = this.agent.stopASR();
                this.socket.emit('asr-status', { active: !result, message: result ? 'ASR stopped' : 'Failed to stop ASR' });
            } catch (error) {
                console.error('Error stopping ASR:', error);
                this.socket.emit('asr-status', { active: true, message: 'Error stopping ASR' });
            }
        });
        
        this.socket.on('get-asr-status', () => {
            try {
                const isActive = this.agent.asr && this.agent.asr.isListening;
                this.socket.emit('asr-status', { active: isActive, message: isActive ? 'ASR is active' : 'ASR is inactive' });
            } catch (error) {
                console.error('Error getting ASR status:', error);
                this.socket.emit('asr-status', { active: false, message: 'Error getting ASR status' });
            }
        });
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }

    // API端点方法（用于REST API，而不是socket连接）
    startASR(req, res) {
        if (this.agent) {
            const result = this.agent.startASR();
            if (result) {
                res.json({ success: true, message: 'ASR started' });
            } else {
                res.status(500).json({ success: false, message: 'Failed to start ASR' });
            }
        } else {
            res.status(404).json({ success: false, message: 'Agent not found' });
        }
    }
      
    stopASR(req, res) {
        if (this.agent) {
            const result = this.agent.stopASR();
            if (result) {
                res.json({ success: true, message: 'ASR stopped' });
            } else {
                res.status(500).json({ success: false, message: 'Failed to stop ASR' });
            }
        } else {
            res.status(404).json({ success: false, message: 'Agent not found' });
        }
    }
}

// Create and export a singleton instance
export const serverProxy = new AgentServerProxy();

export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}
