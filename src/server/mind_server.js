import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { ASRService } from '../utils/asr_service.js';
import settings from '../../settings.js';

// Module-level variables
let io;
let server;
let asrService = null;
const registeredAgents = new Set();
const inGameAgents = {};
const agentManagers = {}; // socket for main process that registers/controls agents

// 添加进程退出时的清理函数
function setupCleanupHandlers() {
    // 处理Ctrl+C和其他进程终止信号
    const cleanupAndExit = (signal) => {
        console.log(`\n接收到${signal}信号，正在清理资源...`);
        
        // 清理ASR服务资源
        if (asrService) {
            console.log('正在关闭ASR服务...');
            try {
                asrService.cleanup();
                console.log('ASR服务已关闭');
            } catch (error) {
                console.error('关闭ASR服务时出错:', error);
            }
        }
        
        // 关闭socket连接
        if (io) {
            console.log('正在关闭Socket.IO连接...');
            io.close();
        }
        
        // 关闭HTTP服务器
        if (server) {
            console.log('正在关闭HTTP服务器...');
            server.close();
        }
        
        console.log('清理完成，退出程序');
        
        // 正常退出进程
        process.exit(0);
    };
    
    // 注册信号处理程序
    process.on('SIGINT', () => cleanupAndExit('SIGINT')); // Ctrl+C
    process.on('SIGTERM', () => cleanupAndExit('SIGTERM')); // kill命令
    
    // 处理未捕获的异常和Promise拒绝
    process.on('uncaughtException', (error) => {
        console.error('未捕获的异常:', error);
        cleanupAndExit('uncaughtException');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('未处理的Promise拒绝:', reason);
        cleanupAndExit('unhandledRejection');
    });
}

// Initialize the server
export function createMindServer(port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);
    
    // 设置清理处理程序
    setupCleanupHandlers();
    
    // 初始化ASR服务（如果启用）
    if (settings.enable_asr) {
        console.log('MindServer: 初始化ASR服务...');
        asrService = new ASRService();
        
        // 初始化ASR服务
        asrService.init().then(asrInitResult => {
            if (asrInitResult) {
                console.log('MindServer: ASR服务初始化成功');
                // 如果配置了自动启动ASR
                if (settings.asr_auto_start) {
                    asrService.startListening();
                    console.log('MindServer: ASR服务已自动启动');
                }
                
                // 设置ASR结果回调
                asrService.onResult = (recognizedText) => {
                    if (recognizedText.trim()) {
                        // 广播ASR识别结果给所有连接的Agent
                        broadcastASRResult(settings.player_name, recognizedText);
                    }
                };
            } else {
                console.error('MindServer: ASR服务初始化失败');
            }
        });
    }

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsUpdate(socket);

        socket.on('register-agents', (agentNames) => {
            console.log(`Registering agents: ${agentNames}`);
            agentNames.forEach(name => registeredAgents.add(name));
            for (let name of agentNames) {
                agentManagers[name] = socket;
            }
            socket.emit('register-agents-success');
            agentsUpdate();
        });

        socket.on('login-agent', (agentName) => {
            if (curAgentName && curAgentName !== agentName) {
                console.warn(`Agent ${agentName} already logged in as ${curAgentName}`);
                return;
            }
            if (registeredAgents.has(agentName)) {
                curAgentName = agentName;
                inGameAgents[agentName] = socket;
                agentsUpdate();
            } else {
                console.warn(`Agent ${agentName} not registered`);
            }
        });

        socket.on('logout-agent', (agentName) => {
            if (inGameAgents[agentName]) {
                delete inGameAgents[agentName];
                agentsUpdate();
            }
        });

        socket.on('disconnect', () => {
            console.log('Client disconnected');
            if (inGameAgents[curAgentName]) {
                delete inGameAgents[curAgentName];
                agentsUpdate();
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!inGameAgents[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            inGameAgents[agentName].emit('chat-message', curAgentName, json);
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            inGameAgents[agentName].emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            let manager = agentManagers[agentName];
            if (manager) {
                manager.emit('stop-agent', agentName);
            }
            else {
                console.warn(`Stopping unregisterd agent ${agentName}`);
            }
        });

        socket.on('start-agent', (agentName) => {
            let manager = agentManagers[agentName];
            if (manager) {
                manager.emit('start-agent', agentName);
            }
            else {
                console.warn(`Starting unregisterd agent ${agentName}`);
            }
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            stopAllAgents();
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let manager of Object.values(agentManagers)) {
                manager.emit('shutdown');
            }
            setTimeout(() => {
                process.exit(0);
            }, 2000);
        });

        socket.on('send-message', (agentName, message) => {
            if (!inGameAgents[agentName]) {
                console.warn(`Agent ${agentName} not logged in, cannot send message via MindServer.`);
                return
            }
            try {
                console.log(`Sending message to agent ${agentName}: ${message}`);
                inGameAgents[agentName].emit('send-message', agentName, message)
            } catch (error) {
                console.error('Error: ', error);
            }
        });
        
        // ASR服务控制
        socket.on('start-asr', () => {
            if (!asrService) {
                socket.emit('asr-status', { active: false, message: 'ASR service not initialized' });
                return;
            }
            
            try {
                asrService.startListening();
                socket.emit('asr-status', { active: true, message: 'ASR started successfully' });
                io.emit('asr-status-change', { active: true });
            } catch (error) {
                console.error('Error starting ASR:', error);
                socket.emit('asr-status', { active: false, message: 'Error starting ASR' });
            }
        });
        
        socket.on('stop-asr', () => {
            if (!asrService) {
                socket.emit('asr-status', { active: false, message: 'ASR service not initialized' });
                return;
            }
            
            try {
                asrService.stopListening();
                socket.emit('asr-status', { active: false, message: 'ASR stopped successfully' });
                io.emit('asr-status-change', { active: false });
            } catch (error) {
                console.error('Error stopping ASR:', error);
                socket.emit('asr-status', { active: false, message: 'Error stopping ASR' });
            }
        });
        
        socket.on('get-asr-status', () => {
            if (!asrService) {
                socket.emit('asr-status', { active: false, message: 'ASR service not initialized' });
                return;
            }
            
            socket.emit('asr-status', { 
                active: asrService.isListening, 
                message: asrService.isListening ? 'ASR is active' : 'ASR is inactive' 
            });
        });
    });

    server.listen(port, 'localhost', () => {
        console.log(`MindServer running on port ${port}`);
    });

    return server;
}

// 广播ASR识别结果给所有连接的Agent
function broadcastASRResult(sender, message) {
    if (!message || !message.trim()) {
        return;
    }
    
    console.log(`ASR识别结果广播: ${message}`);
    
    // 尝试提取消息前缀中的Agent名称
    const targetAgent = extractTargetAgent(message);
    
    if (targetAgent) {
        // 找到特定目标，只发送给指定的Agent
        if (inGameAgents[targetAgent.name]) {
            console.log(`ASR消息发送给指定Agent "${targetAgent.name}"`);
            // 去掉消息前缀的Agent名称
            const cleanMessage = targetAgent.restMessage.trim();
            inGameAgents[targetAgent.name].emit('send-message', targetAgent.name, cleanMessage);
        } else {
            console.warn(`找不到名为 "${targetAgent.name}" 的已连接Agent，执行广播`);
            broadcastMessageToAllAgents(sender, message);
        }
    } else {
        // 没有指定目标，广播给所有Agent
        broadcastMessageToAllAgents(sender, message);
    }
}

// 从消息中提取目标Agent名称
function extractTargetAgent(message) {
    // 如果没有注册Agent，直接返回null
    if (registeredAgents.size === 0) return null;
    
    // 尝试匹配消息开头是否包含Agent名称
    for (const agentName of registeredAgents) {
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

// 广播消息给所有已连接的Agent
function broadcastMessageToAllAgents(sender, message) {
    console.log(`广播ASR消息给所有已连接Agent (${Object.keys(inGameAgents).length}个)`);
    
    for (const agentName in inGameAgents) {
        try {
            inGameAgents[agentName].emit('send-message', agentName, message);
        } catch (error) {
            console.error(`向Agent "${agentName}" 发送消息时出错:`, error);
        }
    }
}

function agentsUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    registeredAgents.forEach(name => {
        agents.push({name, in_game: !!inGameAgents[name]});
    });
    socket.emit('agents-update', agents);
}

function stopAllAgents() {
    for (const agentName in inGameAgents) {
        let manager = agentManagers[agentName];
        if (manager) {
            manager.emit('stop-agent', agentName);
        }
    }
}

// 获取ASR服务的状态
export function getASRStatus() {
    if (!asrService) {
        return { active: false, message: 'ASR service not initialized' };
    }
    
    return { 
        active: asrService.isListening, 
        message: asrService.isListening ? 'ASR is active' : 'ASR is inactive' 
    };
}

// 启动ASR服务
export function startASR() {
    if (!asrService) {
        return { success: false, message: 'ASR service not initialized' };
    }
    
    try {
        asrService.startListening();
        io.emit('asr-status-change', { active: true });
        return { success: true, message: 'ASR started successfully' };
    } catch (error) {
        console.error('Error starting ASR:', error);
        return { success: false, message: 'Error starting ASR' };
    }
}

// 停止ASR服务
export function stopASR() {
    if (!asrService) {
        return { success: false, message: 'ASR service not initialized' };
    }
    
    try {
        asrService.stopListening();
        io.emit('asr-status-change', { active: false });
        return { success: true, message: 'ASR stopped successfully' };
    } catch (error) {
        console.error('Error stopping ASR:', error);
        return { success: false, message: 'Error stopping ASR' };
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const getASRService = () => asrService; 
