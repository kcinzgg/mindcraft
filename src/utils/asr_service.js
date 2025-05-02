/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-30 18:05:16
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-05-02 14:11:04
 * @FilePath: /mindcraft/src/utils/asr_service.js
 * @Description: 豆包ASR语音识别服务
 */
import settings from '../../settings.js';
import zlib from 'zlib';
import crypto from 'crypto';
import WebSocket from 'ws';

// 动态导入全局按键监听器
let GlobalKeyboardListener;
let globalKeyListenerAvailable = false;

try {
    const GKL = await import('node-global-key-listener');
    GlobalKeyboardListener = GKL.GlobalKeyboardListener;
    globalKeyListenerAvailable = true;
} catch (error) {
    console.log("⚠️ 警告: 全局按键监听库加载失败，将使用终端按键绑定。");
    console.log("错误详情:", error.message);
}

// 消息类型常量
const FULL_CLIENT_REQUEST = 0x01;
const AUDIO_ONLY_REQUEST = 0x02;
const FULL_SERVER_RESPONSE = 0x09;
const SERVER_ACK = 0x0B;
const SERVER_ERROR_RESPONSE = 0x0F;

// 消息标记
const NO_SEQUENCE = 0x00;
const POS_SEQUENCE = 0x01;
const NEG_SEQUENCE = 0x02;
const NEG_WITH_SEQUENCE = 0x03;

// 序列化方法
const NO_SERIALIZATION = 0x00;
const JSON_SERIALIZATION = 0x01;

// 压缩方法
const NO_COMPRESSION = 0x00;
const GZIP_COMPRESSION = 0x01;

// VAD 参数
const VAD_MODE = {
    OFF: 0,           // 不使用VAD
    MANUAL: 1,        // 手动启停（热键）
    AUTO: 2,          // 自动启停（静音检测）
    CONTINUOUS: 3     // 持续录音
};

// MacOS下的Ctrl+I键码
const MAC_CTRL_I_KEY = '09'; // TAB键的十六进制码

export class ASRService {
    constructor() {
        this.isListening = false;
        this.apiKey = settings.doubao_asr_key || '';
        this.appId = settings.doubao_app_id || '';
        this.token = settings.doubao_token || '';
        this.wsUrl = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
        this.resourceId = "volc.bigasr.sauc.duration";
        
        this.sequenceNumber = 1;
        this.micInstance = null;
        this.micInputStream = null;
        this.websocket = null;
        this.debug = process.env.NODE_ENV === 'development' || settings.asr_debug; // 开发环境默认开启调试
        this.requestId = this.generateRequestId();
        this.sentAudioPackets = 0;
        this.globalKeyListener = null;
        this.messageHandler = null;
        
        // ASR结果回调
        this.onResult = null;
        
        // VAD设置
        this.vadMode = settings.asr_vad_mode || VAD_MODE.MANUAL;
        this.vadSilenceTimeout = settings.asr_silence_timeout || 2000; // 2秒静音超时
        this.vadThreshold = settings.asr_vad_threshold || 0.01; // 音量阈值
        this.vadSilenceStart = 0;
        this.isVoiceActive = false;
        this.vadAudioBuffer = [];
        this.vadBatchSize = 4; // 累积多少帧音频后再做VAD检测
        this.vadInProgress = false;
        
        // VAD缓冲
        this.audioDataBuffer = [];
        this.maxBufferLength = 100; // 最多缓存100帧，防止内存溢出
        
        if (this.debug) {
            console.log("ASR服务初始化，当前系统:", process.platform);
            console.log("当前VAD模式:", this.vadMode);
        }
    }
    
    generateRequestId() {
        return crypto.randomUUID ? crypto.randomUUID() : `node_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
    
    async init(messageHandler) {
        this.messageHandler = messageHandler;
        
        // 初始化麦克风
        try {
            const mic = await import('mic');
            this.mic = mic.default;
        } catch (error) {
            console.error('无法加载麦克风模块:', error);
            return false;
        }
        
        // 初始化按键监听
        this.initKeyboardEvents();
        
        // 如果启用了自动VAD模式，直接开始监听
        if (this.vadMode === VAD_MODE.AUTO || this.vadMode === VAD_MODE.CONTINUOUS) {
            this.startAudioMonitoring();
        }
        
        return true;
    }
    
    startAudioMonitoring() {
        console.log("启动音频监控...");
        // 启动麦克风但不发送到ASR
        this.setupMicrophone();
        this.micInstance.start();
    }
    
    setupMicrophone() {
        try {
            // 麦克风配置
            this.micInstance = this.mic({
                rate: '16000',
                channels: '1',
                debug: false,
                fileType: 'raw',
                exitOnSilence: 0,
                device: 'default'
            });
            
            this.micInputStream = this.micInstance.getAudioStream();
            
            // 处理音频数据
            this.micInputStream.on('data', (data) => {
                try {
                    // 根据VAD模式处理音频
                    if (this.vadMode === VAD_MODE.AUTO) {
                        this.processAudioWithVAD(data);
                    } else if (this.vadMode === VAD_MODE.CONTINUOUS) {
                        this.processAudioContinuous(data);
                    } else if (this.isListening && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                        this.sendAudioData(data, false);
                    } else if (this.websocket) {
                        console.log(`WebSocket未就绪，状态: ${this.websocket.readyState}`);
                    }
                } catch (error) {
                    console.error("处理音频数据出错:", error);
                }
            });
            
            // 处理错误
            this.micInputStream.on('error', (err) => {
                console.error('麦克风错误:', err);
                this.isListening = false;
            });
        } catch (error) {
            console.error('设置麦克风失败:', error);
        }
    }
    
    // 使用VAD处理音频
    processAudioWithVAD(audioData) {
        // 将音频添加到缓冲区
        this.vadAudioBuffer.push(audioData);
        
        // 达到检测批次大小后进行处理
        if (this.vadAudioBuffer.length >= this.vadBatchSize && !this.vadInProgress) {
            this.vadInProgress = true;
            
            try {
                // 合并音频数据
                const combinedBuffer = Buffer.concat(this.vadAudioBuffer);
                this.vadAudioBuffer = [];
                
                // 计算音量
                const volume = this.calculateVolume(combinedBuffer);
                
                // 当前时间
                const now = Date.now();
                
                // 有声音活动
                if (volume > this.vadThreshold) {
                    // 如果之前没有在录音，则开始录音
                    if (!this.isListening) {
                        console.log(`检测到语音活动 (音量: ${volume.toFixed(4)}), 开始录音...`);
                        this.startListening();
                    }
                    
                    // 重置静音计时器
                    this.vadSilenceStart = 0;
                    
                    // 发送音频
                    if (this.isListening && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                        this.sendAudioData(combinedBuffer, false);
                    }
                } else {
                    // 静音
                    if (this.isListening) {
                        // 如果这是静音的开始
                        if (this.vadSilenceStart === 0) {
                            this.vadSilenceStart = now;
                        }
                        
                        // 如果仍在录音，需要发送静音数据
                        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                            this.sendAudioData(combinedBuffer, false);
                        }
                        
                        // 检查是否超过静音超时
                        if (this.vadSilenceStart > 0 && now - this.vadSilenceStart > this.vadSilenceTimeout) {
                            console.log(`检测到静音超过 ${this.vadSilenceTimeout/1000}秒, 停止录音...`);
                            this.stopListening();
                        }
                    }
                }
            } catch (error) {
                console.error("VAD处理出错:", error);
            }
            
            this.vadInProgress = false;
        }
    }
    
    // 持续处理音频
    processAudioContinuous(audioData) {
        // 在连续模式中，我们始终保持录音状态
        if (!this.isListening) {
            this.startListening();
        }
        
        // 发送音频数据
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.sendAudioData(audioData, false);
        }
    }
    
    // 计算音频缓冲区的音量
    calculateVolume(buffer) {
        if (!buffer || buffer.length === 0) return 0;
        
        try {
            // 音频格式是16位PCM
            const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
            
            // 计算平均能量
            let sum = 0;
            for (let i = 0; i < samples.length; i++) {
                sum += Math.abs(samples[i]);
            }
            
            // 归一化音量（0-1范围）
            return sum / (samples.length * 32768);
        } catch (error) {
            console.error("计算音量出错:", error);
            return 0;
        }
    }
    
    initKeyboardEvents() {
        // 如果使用的是自动VAD模式，不需要键盘控制
        if (this.vadMode === VAD_MODE.AUTO || this.vadMode === VAD_MODE.CONTINUOUS) {
            console.log(`使用${this.vadMode === VAD_MODE.AUTO ? '自动语音检测' : '持续录音'}模式，无需键盘控制`);
            return;
        }
        
        // 如果全局按键监听器可用，则使用它
        if (globalKeyListenerAvailable) {
            try {
                // 首先提示用户可能需要手动授权
                if (process.platform === 'darwin') {
                    console.log("注意: 在macOS上，全局按键监听需要特殊权限。");
                    console.log("如果遇到权限问题，请尝试以下步骤:");
                    console.log("1. 手动执行: chmod +x node_modules/node-global-key-listener/bin/MacKeyServer");
                    console.log("2. 如需查看详细按键调试信息，请使用 --debug 参数启动程序");
                }
                
                const gklOptions = {
                    windows: { 
                        // Windows默认选项
                    },
                    mac: {
                        // 配置MacOS按键服务器
                        macKeyServerPath: 'node_modules/node-global-key-listener/bin/MacKeyServer',
                        debug: this.debug
                    },
                    linux: {
                        // Linux默认选项
                    }
                };
                
                // 创建全局按键监听器
                this.globalKeyListener = new GlobalKeyboardListener(gklOptions);
                
                if (this.debug) {
                    console.log("全局按键监听器已创建，系统:", process.platform);
                }
                
                // 注册 Ctrl+I 快捷键用于开始/停止录音
                this.globalKeyListener.addListener((e, down) => {
                    // 列出所有当前按下的键，帮助调试
                    if (this.debug) {
                        const pressedKeys = Object.keys(down).filter(key => down[key]);
                        console.log(`按键事件: ${e.name}, 状态: ${e.state}`);
                        console.log(`当前按下的键:`, pressedKeys);
                    }
                    
                    const isMac = process.platform === 'darwin';
                    
                    // 根据系统平台使用不同的修饰键
                    let modifierKey = false;
                    if (isMac) {
                        // MacOS下使用Command键
                        modifierKey = down["LEFT META"] || down["RIGHT META"];
                    } else {
                        // Windows/Linux下使用Ctrl键
                        modifierKey = down["LEFT CONTROL"] || down["RIGHT CONTROL"];
                    }
                    
                    // 当按下 I 键并同时按下修饰键 (MacOS用Command+I, 其他系统用Ctrl+I)
                    if (e.name === "I" && modifierKey) {
                        const modifierName = isMac ? 'Command' : 'Ctrl';
                        // console.log(`检测到${modifierName}+I ${e.state === "DOWN" ? "按下" : "释放"}`);
                        
                        // 按下按键时开始录音
                        if (e.state === "DOWN" && !this.isListening) {
                            console.log(`开始录音...`);
                            this.startListening();
                        } 
                        // 释放按键时停止录音
                        else if (e.state === "UP" && this.isListening) {
                            console.log(`停止录音...`);
                            this.stopListening();
                        }
                        
                        // 返回true表示拦截此按键，不传递给其他应用
                        return true;
                    }
                    
                    // 不拦截其他按键
                    return false;
                });
                
                const modifierKey = isMac ? 'Command' : 'Ctrl';
                console.log(`已启用全局热键监听，按住 ${modifierKey}+I 录音，松开停止录音`);
            } catch (error) {
                console.error("全局热键监听初始化失败:", error.message);
                this.initTerminalKeyboardEvents();
            }
        } else {
            // 如果全局按键监听器不可用，则使用终端按键监听
            this.initTerminalKeyboardEvents();
        }
    }
    
    initTerminalKeyboardEvents() {
        const isMac = process.platform === 'darwin';
        const modifierKey = isMac ? 'Command' : 'Ctrl';
        
        console.log("\n=== 终端按键模式 ===");
        console.log("使用终端按键绑定，只在终端窗口有焦点时有效");
        console.log(`· 由于终端限制，无法完全模拟${modifierKey}+I的按下/释放行为`);
        console.log(`· 按 ${modifierKey}+I (TAB键): 开始录音`);
        console.log(`· 按 ${modifierKey}+R: 停止录音`);
        console.log("· 按Ctrl+C: 退出程序");
        console.log("=============================\n");
        
        process.stdin.setRawMode(true);
        process.stdin.resume();
        
        let isRecording = false;
        
        process.stdin.on('data', (key) => {
            // 转换为十六进制查看按键码
            const keyHex = Array.from(key).map(k => k.toString(16).padStart(2, '0')).join('');
            if (this.debug) {
                console.log(`按键按下, 十六进制: ${keyHex}`);
            }
            
            // Tab键 (Ctrl+I的终端编码)
            if (keyHex === '09') {
                if (!this.isListening) {
                    console.log(`检测到${modifierKey}+I按下，开始录音...`);
                    this.startListening();
                    isRecording = true;
                }
            } 
            // Ctrl+R (ASCII 12)
            else if (keyHex === '12') {
                if (this.isListening) {
                    console.log(`检测到${modifierKey}+R按下，停止录音...`);
                    this.stopListening();
                    isRecording = false;
                }
            }
            // 按Ctrl+C退出
            else if (keyHex === '03') {
                this.cleanup();
                process.exit(0);
            }
        });
    }
    
    startListening() {
        if (this.isListening) return;
        
        try {
            // 先建立WebSocket连接
            this.setupWebSocket();
            
            // 如果不是自动VAD模式，需要创建麦克风实例
            if (this.vadMode !== VAD_MODE.AUTO && this.vadMode !== VAD_MODE.CONTINUOUS) {
                this.setupMicrophone();
                this.micInstance.start();
            }
            
            this.isListening = true;
            console.log("开始录音...");
        } catch (error) {
            console.error('启动录音失败:', error);
        }
    }
    
    stopListening() {
        if (!this.isListening) return;
        
        try {
            // 在自动VAD模式下，我们不停止麦克风，只结束当前的识别会话
            if (this.vadMode !== VAD_MODE.AUTO && this.vadMode !== VAD_MODE.CONTINUOUS) {
                this.micInstance.stop();
            }
            
            // 发送结束标记
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.sendAudioData(Buffer.alloc(0), true);
            }
            
            // 重置VAD状态
            this.vadSilenceStart = 0;
        } catch (error) {
            console.error('停止录音失败:', error);
        }
        
        this.isListening = false;
        console.log("停止录音");
    }
    
    cleanup() {
        // 停止录音
        if (this.isListening) {
            try {
                this.stopListening();
            } catch (error) {
                console.error("停止录音失败:", error);
            }
        }
        
        // 如果是自动VAD或持续模式，需要特别停止麦克风
        if ((this.vadMode === VAD_MODE.AUTO || this.vadMode === VAD_MODE.CONTINUOUS) && this.micInstance) {
            try {
                this.micInstance.stop();
                console.log("停止音频监控...");
            } catch (error) {
                console.error("停止音频监控失败:", error);
            }
        }
        
        // 关闭WebSocket连接
        if (this.websocket) {
            try {
                this.websocket.close();
            } catch (error) {
                console.error("关闭WebSocket连接失败:", error);
            }
        }
        
        // 停止全局热键监听
        if (this.globalKeyListener) {
            try {
                this.globalKeyListener = null;
            } catch (error) {
                console.error("停止全局热键监听失败:", error);
            }
        }
        
        // 清理其他资源
        this.vadAudioBuffer = [];
        this.audioDataBuffer = [];
        this.websocket = null;
        this.isListening = false;
    }
    
    setupWebSocket() {
        try {
            // 如果已经存在连接，先关闭
            if (this.websocket) {
                try {
                    this.websocket.close();
                } catch (e) {
                    console.error("关闭现有WebSocket连接失败:", e);
                }
                this.websocket = null;
            }
            
            // 重新连接时重置序列号
            this.sequenceNumber = 1;
            this.sentAudioPackets = 0;
            this.requestId = this.generateRequestId();
            
            // 按照Python代码设置headers
            const headers = {
                "X-Api-Resource-Id": this.resourceId,
                "X-Api-Access-Key": this.token,
                "X-Api-App-Key": this.appId,
                "X-Api-Request-Id": this.requestId
            };
            
            if (this.debug) {
                console.log("连接WebSocket，headers:", headers);
            }
            
            // 创建WebSocket连接
            this.websocket = new WebSocket(this.wsUrl, {
                headers: headers,
                rejectUnauthorized: false, // 允许自签名证书
                handshakeTimeout: 10000 // 10秒超时
            });
            
            this.websocket.onopen = () => {
                console.log("WebSocket已连接");
                this.sendInitialRequest();
            };
            
            this.websocket.onmessage = (event) => {
                try {
                    if (this.debug && event.data) {
                        const dataLength = typeof event.data.length === 'number' ? event.data.length : '未知';
                        console.log(`收到服务器消息，长度: ${dataLength} 字节`);
                    }
                    this.handleWebSocketMessage(event.data);
                } catch (error) {
                    console.error("处理WebSocket消息事件失败:", error);
                }
            };
            
            this.websocket.onerror = (error) => {
                console.error("WebSocket错误:", error);
            };
            
            this.websocket.onclose = (event) => {
                console.log(`WebSocket连接关闭: ${event.code} ${event.reason || ""}`);
            };
        } catch (error) {
            console.error("设置WebSocket连接失败:", error);
            this.websocket = null;
        }
    }
    
    sendInitialRequest() {
        // 构建初始请求
        const requestData = {
            user: {
                uid: "mindcraft_user"
            },
            audio: {
                format: "pcm",
                sample_rate: 16000,
                bits: 16,
                channel: 1,
                codec: "raw"
            },
            request: {
                model_name: "bigmodel",
                enable_punc: true
            }
        };
        
        // 按协议格式构建和发送请求
        const jsonData = JSON.stringify(requestData);
        
        if (this.debug) {
            console.log("初始请求数据:", jsonData);
        }
        
        // 使用zlib压缩数据
        const compressedData = zlib.gzipSync(Buffer.from(jsonData));
        
        // 创建完整请求
        const fullRequest = this.createFullRequest(compressedData);
        
        if (this.debug) {
            console.log(`发送初始请求，数据长度: ${fullRequest.length} 字节`);
        }
        
        this.websocket.send(fullRequest);
        
        // 发送初始请求后立即递增序列号
        this.sequenceNumber++;
    }
    
    sendAudioData(audioData, isLast) {
        if (!this.websocket) {
            console.error("WebSocket连接未初始化");
            return;
        }
        
        if (this.websocket.readyState !== WebSocket.OPEN) {
            console.error(`WebSocket连接未打开，当前状态: ${this.websocket.readyState}`);
            return;
        }
        
        try {
            // 确保audioData是有效的Buffer
            if (!Buffer.isBuffer(audioData)) {
                if (isLast) {
                    audioData = Buffer.alloc(0);
                } else {
                    console.error("无效的音频数据类型，预期为Buffer");
                    return;
                }
            }
            
            this.sentAudioPackets++; // 增加已发送的音频包计数
            
            // 使用zlib压缩数据
            const compressedData = zlib.gzipSync(audioData);
            
            // 创建音频请求
            const audioRequest = this.createAudioRequest(compressedData, isLast);
            
            // 发送
            this.websocket.send(audioRequest);
            
            if (!isLast) {
                this.sequenceNumber++;
            }
        } catch (error) {
            console.error('发送音频数据失败:', error);
        }
    }
    
    createFullRequest(payload) {
        // 创建请求头
        const header = Buffer.from([
            0x11, // 版本(4位)|头大小(4位) = 0001 0001
            0x11, // 消息类型(4位)|消息标记(4位) = 0001 0001
            0x11, // 序列化方法(4位)|压缩类型(4位) = 0001 0001
            0x00  // 保留字段
        ]);
        
        const sequence = this.intToBytes(this.sequenceNumber);
        const payloadLength = this.intToBytes(payload.length);
        
        return Buffer.concat([header, sequence, payloadLength, payload]);
    }
    
    createAudioRequest(payload, isLast) {
        let msgType;
        
        if (isLast) {
            // 使用负序列标志表示最后一帧
            msgType = Buffer.from([
                0x11, // 版本(4位)|头大小(4位) = 0001 0001
                0x23, // 消息类型(4位)|消息标记(4位) = 0010 0011 (AUDIO_ONLY_REQUEST | NEG_WITH_SEQUENCE)
                0x11, // 序列化方法(4位)|压缩类型(4位) = 0001 0001
                0x00  // 保留字段
            ]);
        } else {
            msgType = Buffer.from([
                0x11, // 版本(4位)|头大小(4位) = 0001 0001
                0x21, // 消息类型(4位)|消息标记(4位) = 0010 0001 (AUDIO_ONLY_REQUEST | POS_SEQUENCE)
                0x11, // 序列化方法(4位)|压缩类型(4位) = 0001 0001
                0x00  // 保留字段
            ]);
        }
        
        const sequence = this.intToBytes(isLast ? -this.sequenceNumber : this.sequenceNumber);
        const payloadLength = this.intToBytes(payload.length);
        
        return Buffer.concat([msgType, sequence, payloadLength, payload]);
    }
    
    handleWebSocketMessage(data) {
        try {
            // 确保data是Buffer类型
            let responseBuffer;
            if (Buffer.isBuffer(data)) {
                responseBuffer = data;
            } else if (typeof data === 'string') {
                responseBuffer = Buffer.from(data);
            } else if (data instanceof ArrayBuffer) {
                responseBuffer = Buffer.from(data);
            } else if (data && data.buffer instanceof ArrayBuffer) {
                // 处理TypedArray (Uint8Array等)
                responseBuffer = Buffer.from(data.buffer);
            } else {
                console.error("未知的数据类型:", typeof data);
                return;
            }
            
            // 检查是否是JSON格式的错误消息（以 '{' 开头）
            if (responseBuffer.length > 0 && responseBuffer[0] === 0x7B) { // 0x7B是'{'的ASCII码
                try {
                    const jsonStr = responseBuffer.toString('utf8');
                    console.log("收到JSON错误消息:", jsonStr);
                    const jsonObj = JSON.parse(jsonStr);
                    if (jsonObj.error) {
                        console.error("服务器错误:", jsonObj.error);
                    }
                    return;
                } catch (jsonError) {
                    console.error("解析JSON错误消息失败:", jsonError);
                }
            }
            
            if (responseBuffer.length < 4) {
                console.error("收到的消息太短，无法解析头部");
                return;
            }
            
            // 解析头部
            const headerVersion = (responseBuffer[0] >> 4) & 0x0F;
            const headerSize = responseBuffer[0] & 0x0F;
            const messageType = (responseBuffer[1] >> 4) & 0x0F;
            const messageTypeFlags = responseBuffer[1] & 0x0F;
            const serialMethod = (responseBuffer[2] >> 4) & 0x0F;
            const compressType = responseBuffer[2] & 0x0F;
            
            // 确保消息长度足够
            if (responseBuffer.length < headerSize * 4) {
                console.error(`消息长度不足，无法解析完整头部: ${responseBuffer.length} < ${headerSize * 4}`);
                return;
            }
            
            // 处理不同类型的消息
            let result = {
                isLastPackage: false
            };
            
            let payload = responseBuffer.slice(headerSize * 4);
            
            // 检查是否有序列号
            if (messageTypeFlags & 0x01) {
                if (payload.length < 4) {
                    console.error("消息太短，无法读取序列号");
                    return;
                }
                const sequence = payload.readInt32BE(0);
                payload = payload.slice(4);
                result.sequence = sequence;
            }
            
            // 检查是否是最后一包
            if (messageTypeFlags & 0x02) {
                result.isLastPackage = true;
            }
            
            // 根据消息类型处理载荷
            if (messageType === FULL_SERVER_RESPONSE) {
                this.handleFullServerResponse(payload, serialMethod, compressType);
            } else if (messageType === SERVER_ACK) {
                // 处理确认消息
            } else if (messageType === SERVER_ERROR_RESPONSE) {
                this.handleServerError(payload);
            }
        } catch (error) {
            console.error("处理WebSocket消息失败:", error);
        }
    }
    
    handleFullServerResponse(payload, serialMethod, compressType) {
        try {
            // 读取载荷大小和载荷内容
            if (payload.length < 4) {
                console.error("消息太短，无法读取载荷大小");
                return;
            }
            
            const payloadSize = payload.readInt32BE(0);
            payload = payload.slice(4);
            
            // 提取实际需要的载荷
            if (payload.length < payloadSize) {
                console.error(`载荷长度不足: ${payload.length} < ${payloadSize}`);
                return;
            }
            const actualPayload = payload.slice(0, payloadSize);
            
            // 解压缩载荷(如果需要)
            let decompressedPayload;
            if (compressType === GZIP_COMPRESSION) {
                try {
                    decompressedPayload = zlib.gunzipSync(actualPayload);
                } catch (error) {
                    console.error("解压缩载荷失败:", error);
                    return;
                }
            } else {
                decompressedPayload = actualPayload;
            }
            
            // 解析JSON(如果需要)
            let resultData;
            if (serialMethod === JSON_SERIALIZATION) {
                try {
                    const jsonStr = decompressedPayload.toString('utf8');
                    resultData = JSON.parse(jsonStr);
                } catch (error) {
                    console.error("解析JSON失败:", error);
                    return;
                }
            } else {
                resultData = decompressedPayload.toString('utf8');
            }
            
            // 处理识别结果
            this.handleRecognitionResult(resultData);
        } catch (error) {
            console.error("处理服务器响应失败:", error);
        }
    }
    
    handleRecognitionResult(data) {
        if (data && data.result && data.result.text) {
            const recognizedText = data.result.text;
            
            console.log("\n识别结果: " + recognizedText);
            
            // 如果有回调函数，调用它
            if (typeof this.onResult === 'function') {
                this.onResult(recognizedText);
            }
            
            // 如果有消息处理函数，调用它
            if (this.messageHandler && recognizedText.trim()) {
                this.messageHandler(settings.player_name, recognizedText);
            }
        }
    }
    
    handleServerError(payload) {
        try {
            if (payload.length < 4) {
                console.error("错误消息太短，无法读取错误码");
                return;
            }
            
            const errorCode = payload.readInt32BE(0);
            console.error(`服务器返回错误码: ${errorCode}`);
            
            // 检查是否有错误信息
            if (payload.length >= 8) {
                const payloadSize = payload.readInt32BE(4);
                if (payloadSize > 0 && payload.length >= 8 + payloadSize) {
                    const errorMessage = payload.slice(8, 8 + payloadSize);
                    console.error("错误信息:", errorMessage.toString());
                }
            }
        } catch (error) {
            console.error("处理服务器错误失败:", error);
        }
    }
    
    // 工具方法
    intToBytes(num) {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(num);
        return buf;
    }
    
    async recognizeSpeech(audioData) {
        // 这个方法在当前实现中不直接使用
        // 语音识别是通过WebSocket流式处理的
        return null;
    }
}