/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-30 18:05:16
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-04-30 19:02:17
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
        this.debug = settings.asr_debug || false;
        this.requestId = this.generateRequestId();
        this.sentAudioPackets = 0;
        this.globalKeyListener = null;
        this.messageHandler = null;
        
        // ASR结果回调
        this.onResult = null;
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
        
        return true;
    }
    
    initKeyboardEvents() {
        // 如果全局按键监听器可用，则使用它
        if (globalKeyListenerAvailable) {
            try {
                // 首先提示用户可能需要手动授权
                if (process.platform === 'darwin') {
                    console.log("注意: 在macOS上，全局按键监听需要特殊权限。");
                    console.log("如果遇到权限问题，请尝试以下步骤:");
                    console.log("1. 手动执行: chmod +x node_modules/node-global-key-listener/bin/MacKeyServer");
                }
                
                this.globalKeyListener = new GlobalKeyboardListener();
                
                // 注册 Ctrl+Shift+T / Command+Shift+T 快捷键用于开始/停止录音
                this.globalKeyListener.addListener((e, down) => {
                    const isMac = process.platform === 'darwin';
                    const metaKey = isMac ? (down["LEFT META"] || down["RIGHT META"]) : (down["LEFT CONTROL"] || down["RIGHT CONTROL"]);
                    const shiftKey = down["LEFT SHIFT"] || down["RIGHT SHIFT"];
                    
                    // 当按下 T 键并同时按下 Command+Shift (Mac) 或 Ctrl+Shift (Windows/Linux)
                    if (e.state === "DOWN" && e.name === "T" && metaKey && shiftKey) {
                        console.log(`检测到全局热键: ${isMac ? 'Command' : 'Ctrl'}+Shift+T`);
                        
                        if (this.isListening) {
                            this.stopListening();
                        } else {
                            this.startListening();
                        }
                        
                        // 返回true表示拦截此按键，不传递给其他应用
                        return true;
                    }
                    
                    // 不拦截其他按键
                    return false;
                });
                
                console.log("已启用全局热键监听，按 Cmd+Shift+T (Mac) 或 Ctrl+Shift+T (Windows/Linux) 开始/停止录音");
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
        console.log("\n=== 终端按键模式 ===");
        console.log("使用终端按键绑定，只在终端窗口有焦点时有效");
        console.log("· 按空格键: 开始/停止语音识别");
        console.log("· 按Ctrl+C: 退出程序");
        console.log("=============================\n");
        
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (key) => {
            // 按空格键开始/停止录音
            if (key.toString() === ' ') {
                if (this.isListening) {
                    this.stopListening();
                } else {
                    this.startListening();
                }
            }
            // 按Ctrl+C退出
            else if (key.toString() === '\u0003') {
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
                    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                        this.sendAudioData(data, false);
                    } else if (this.websocket) {
                        console.log(`WebSocket未就绪，状态: ${this.websocket.readyState}`);
                    } else {
                        console.log("WebSocket连接未初始化");
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
            
            this.micInstance.start();
            this.isListening = true;
            console.log("开始录音...");
        } catch (error) {
            console.error('启动录音失败:', error);
        }
    }
    
    stopListening() {
        if (!this.isListening) return;
        
        try {
            this.micInstance.stop();
            
            // 发送结束标记
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.sendAudioData(Buffer.alloc(0), true);
            }
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
                this.messageHandler('nick', recognizedText);
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