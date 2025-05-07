/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-05 21:35:59
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-05-06 19:34:31
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
                this.agent.respondFunc(settings.player_name, message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });
        
        // MindServer现在已经集成了ASR服务，
        // 接收ASR状态更新事件
        this.socket.on('asr-status-change', (status) => {
            console.log(`收到ASR状态更新: ${status.active ? '已激活' : '已停止'}`);
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

    // 更新API端点方法，转发请求到MindServer
    startASR(req, res) {
        if (this.connected) {
            this.socket.emit('start-asr');
            this.socket.once('asr-status', (status) => {
                if (status.active) {
                    res.json({ success: true, message: status.message });
                } else {
                    res.status(500).json({ success: false, message: status.message });
                }
            });
        } else {
            res.status(503).json({ success: false, message: 'Not connected to MindServer' });
        }
    }
      
    stopASR(req, res) {
        if (this.connected) {
            this.socket.emit('stop-asr');
            this.socket.once('asr-status', (status) => {
                if (!status.active) {
                    res.json({ success: true, message: status.message });
                } else {
                    res.status(500).json({ success: false, message: status.message });
                }
            });
        } else {
            res.status(503).json({ success: false, message: 'Not connected to MindServer' });
        }
    }
    
    getASRStatus(req, res) {
        if (this.connected) {
            this.socket.emit('get-asr-status');
            this.socket.once('asr-status', (status) => {
                res.json({ active: status.active, message: status.message });
            });
        } else {
            res.status(503).json({ success: false, message: 'Not connected to MindServer' });
        }
    }
}

// Create and export a singleton instance
export const serverProxy = new AgentServerProxy();

export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}
