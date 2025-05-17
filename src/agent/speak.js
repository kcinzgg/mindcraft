/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-05-02 13:34:45
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-05-17 21:11:49
 * @FilePath: /mindcraft/src/agent/speak.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import zlib from 'zlib';
import settings from '../../settings.js';

let speakingQueue = [];
let isSpeaking = false;

// 初始化目录
const initDirectories = () => {
  const cacheDir = path.join(process.cwd(), 'tts_cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
};

// 初始化
const initialize = () => {
  if (settings.tts_initialized) return;
  
  initDirectories();
  settings.tts_initialized = true;
};

/**
 * 将文本转换为语音并播放
 * @param {string} textToSpeak 要转换为语音的文本
 * @param {object} agent 可选，当前Agent实例，用于获取自定义TTS配置
 */
export function say(textToSpeak, agent = null) {
  if (!settings.speak) return;
  
  initialize();
  
  if (!textToSpeak || textToSpeak.trim() === '') return;
  
  // 创建带有Agent信息的消息对象
  const messageObj = {
    text: textToSpeak,
    agent: agent
  };
  
  speakingQueue.push(messageObj);
  if (!isSpeaking) {
    processQueue();
  }
}

/**
 * 处理语音队列
 */
async function processQueue() {
  if (speakingQueue.length === 0) {
    isSpeaking = false;
    return;
  }

  isSpeaking = true;
  const messageObj = speakingQueue.shift();
  const textToSpeak = messageObj.text;
  const agent = messageObj.agent;
  
  try {
    // 获取TTS配置
    const ttsConfig = getTTSConfig(agent);
    
    // 根据配置选择TTS引擎
    switch(ttsConfig.engine) {
      case 'bytedance':
        if (settings.bytedance_tts_app_id && settings.bytedance_tts_token) {
          await useBytedanceTTS(textToSpeak, ttsConfig);
        } else {
          if (settings.tts_debug) {
            console.warn('字节TTS配置不完整，回退到系统TTS');
          }
          useSystemTTS(textToSpeak);
        }
        break;
      case 'system':
      default:
        useSystemTTS(textToSpeak);
        break;
    }
  } catch (error) {
    console.error('TTS处理错误，回退到系统TTS:', error);
    useSystemTTS(textToSpeak);
  }
}

/**
 * 获取TTS配置，优先使用Agent特定配置，其次使用全局配置
 * @param {object} agent Agent实例
 * @returns {object} TTS配置
 */
function getTTSConfig(agent) {
  const defaultConfig = {
    engine: settings.tts_engine || 'system',
    voice: settings.bytedance_tts_voice || 'zh_male_yangguangqingnian_emo_v2_mars_bigtts',
    emotion: 'neutral'
  };
  
  if (!agent || !agent.prompter || !agent.prompter.profile || !agent.prompter.profile.tts) {
    return defaultConfig;
  }
  
  const agentTTS = agent.prompter.profile.tts;
  
  return {
    engine: agentTTS.engine || defaultConfig.engine,
    voice: agentTTS.voice || defaultConfig.voice,
    emotion: agentTTS.emotion || defaultConfig.emotion
  };
}

/**
 * 使用系统的文本转语音功能
 * @param {string} textToSpeak 要转换为语音的文本
 */
function useSystemTTS(textToSpeak) {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  let command;

  if (isWin) {
    command = `powershell -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 2; $s.Speak(\\"${textToSpeak}\\"); $s.Dispose()"`;
  } else if (isMac) {
    command = `say "${textToSpeak}"`;
  } else {
    command = `espeak "${textToSpeak}"`;
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`系统TTS错误: ${error.message}`);
      console.error(`${error.stack}`);
    } else if (stderr) {
      console.error(`系统TTS错误: ${stderr}`);
    }
    
    if (settings.tts_debug) {
      console.log(`系统TTS完成: "${textToSpeak.substring(0, 30)}${textToSpeak.length > 30 ? '...' : ''}"`);
    }
    
    processQueue(); // 继续处理队列中的下一条消息
  });
}

/**
 * 从文本中解析情感标记
 * @param {string} text 带有情感标记的原始文本
 * @param {string} defaultEmotion 默认情感
 * @returns {Object} 包含清理后的文本和解析到的情感
 */
function parseEmotion(text, defaultEmotion = 'neutral') {
  // 支持的情感类型映射表
  const emotionMap = {
    // 英文情感标记
    'happy': 'happy',
    'sad': 'sad',
    'angry': 'angry',
    'fear': 'fear',
    'neutral': 'neutral',
    'excited': 'excited',
    'coldness': 'coldness',
    
    // 中文情感标记映射到英文
    '开心': 'happy',
    '高兴': 'happy',
    '快乐': 'happy',
    '悲伤': 'sad',
    '伤心': 'sad',
    '难过': 'sad',
    '愤怒': 'angry',
    '生气': 'angry',
    '恐惧': 'fear',
    '害怕': 'fear',
    '惊讶': 'excited',
    '惊喜': 'excited',
    '平静': 'neutral',
    '中性': 'neutral',
    '冷漠': 'coldness'
  };

  // 匹配括号内的情感标记: (情感)文本
  const emotionRegex = /^\(([^)]+)\)(.+)$/;
  const match = text.match(emotionRegex);

  if (match) {
    const emotionKey = match[1].trim();
    const cleanText = match[2].trim();

    // 查找匹配的情感类型
    const emotion = emotionMap[emotionKey];

    if (emotion) {
      return {
        text: cleanText,
        emotion: emotion
      };
    } else {
      if (settings.tts_debug) {
        console.log(`未识别的情感类型: "${emotionKey}"，使用默认情感`);
      }
    }
  }

  // 如果没有检测到情感标记，返回原始文本和默认情感
  return {
    text: text,
    emotion: defaultEmotion
  };
}

/**
 * 使用字节跳动的文本转语音功能
 * @param {string} textToSpeak 要转换为语音的文本
 * @param {object} config TTS配置
 */
async function useBytedanceTTS(textToSpeak, config) {
  return new Promise((resolve, reject) => {
    try {
      const emotionInfo = parseEmotion(textToSpeak, config.emotion);
      
      // 构建请求参数
      const requestJson = {
        "app": {
          "appid": settings.bytedance_tts_app_id,
          "token": settings.bytedance_tts_token,
          "cluster": "volcano_tts"
        },
        "user": {
          "uid": "388808087185088"
        },
        "audio": {
          "voice_type": config.voice,
          "encoding": "mp3",
          "speed_ratio": 1.0,
          "volume_ratio": 1.0,
          "pitch_ratio": 1.0,
          "emotion": emotionInfo.emotion,
          "enable_emotion": true
        },
        "request": {
          "reqid": uuidv4(),
          "text": emotionInfo.text,
          "text_type": "plain",
          "operation": "submit"
        }
      };
      
      if (settings.tts_debug) {
        console.log(`字节TTS开始处理: "${emotionInfo.text.substring(0, 30)}${emotionInfo.text.length > 30 ? '...' : ''}"`);
        console.log(`使用音色: ${config.voice}, 情感类型: ${emotionInfo.emotion}`);
      }
      
      // 构建并发送WebSocket请求
      const api_url = `wss://openspeech.bytedance.com/api/v1/tts/ws_binary`;
      
      // 准备请求头和请求体
      const defaultHeader = Buffer.from([0x11, 0x10, 0x11, 0x00]);
      const payloadBytes = Buffer.from(JSON.stringify(requestJson), 'utf-8');
      const compressedPayload = zlib.gzipSync(payloadBytes);
      
      const fullClientRequest = Buffer.concat([
        defaultHeader,
        Buffer.alloc(4), // 后面会填充payload大小
        compressedPayload
      ]);
      
      // 填充payload大小
      fullClientRequest.writeUInt32BE(compressedPayload.length, 4);
      
      // 创建一个内存缓冲区收集器，用于存储音频数据
      const audioChunks = [];
      
      const ws = new WebSocket(api_url, {
        headers: {
          "Authorization": `Bearer; ${settings.bytedance_tts_token}`
        }
      });
      
      ws.on('open', () => {
        if (settings.tts_debug) {
          console.log('字节TTS WebSocket连接已建立');
        }
        ws.send(fullClientRequest);
      });
      
      ws.on('message', async (data) => {
        const result = parseResponseInMemory(data, audioChunks);
        if (result.done) {
          if (settings.tts_debug) {
            console.log('字节TTS合成完成，正在关闭连接...');
          }
          ws.close();
          
          if (result.error) {
            reject(new Error(result.error));
            return;
          }
          
          // 合并所有音频块为一个缓冲区
          const audioBuffer = Buffer.concat(audioChunks);
          
          // 使用项目内的temp目录存放临时文件
          const tempFilePath = path.join(process.cwd(), 'temp', `tts_temp_${Date.now()}.mp3`);
          fs.writeFileSync(tempFilePath, audioBuffer);
          
          if (settings.tts_debug) {
            console.log(`字节TTS音频已保存至: ${tempFilePath}`);
          }
          
          // 播放临时文件
          await playAudio(tempFilePath);
          
          // 在播放后删除临时文件
          try {
            fs.unlinkSync(tempFilePath);
            if (settings.tts_debug) {
              console.log(`临时文件已删除: ${tempFilePath}`);
            }
          } catch (unlinkError) {
            console.error(`删除临时文件失败: ${unlinkError}`);
          }
          
          // 处理完成，继续队列
          processQueue();
          resolve();
        }
      });
      
      ws.on('error', (error) => {
        console.error('字节TTS WebSocket错误:', error);
        ws.close();
        reject(error);
      });
      
      ws.on('close', () => {
        if (settings.tts_debug) {
          console.log('字节TTS WebSocket连接已关闭');
        }
      });
      
    } catch (error) {
      console.error('字节TTS处理错误:', error);
      reject(error);
    }
  });
}

/**
 * 解析字节TTS服务器响应并将音频数据收集到内存中
 * @param {Buffer} res 响应数据
 * @param {Array} audioChunks 用于收集音频数据的缓冲区数组
 * @returns {Object} 返回对象包含done状态
 */
function parseResponseInMemory(res, audioChunks) {
  const protocolVersion = res[0] >> 4;
  const headerSize = res[0] & 0x0f;
  const messageType = res[1] >> 4;
  const messageTypeSpecificFlags = res[1] & 0x0f;
  const payload = res.slice(headerSize * 4);

  if (messageType === 0xb) { // audio-only server response
    if (messageTypeSpecificFlags === 0) { // no sequence number as ACK
      return { done: false };
    } else {
      const sequenceNumber = payload.readInt32BE(0);
      const payloadSize = payload.readUInt32BE(4);
      const audioPayload = payload.slice(8);

      // 将音频数据添加到内存缓冲区数组中
      audioChunks.push(audioPayload);

      if (sequenceNumber < 0) {
        return { done: true };
      } else {
        return { done: false };
      }
    }
  } else if (messageType === 0xf) { // error message
    const code = payload.readUInt32BE(0);
    const msgSize = payload.readUInt32BE(4);
    let errorMsg = payload.slice(8);

    if ((res[2] & 0x0f) === 1) { // gzip compression
      errorMsg = zlib.gunzipSync(errorMsg);
    }

    errorMsg = errorMsg.toString('utf-8');

    console.error(`字节TTS错误代码: ${code}, 错误信息: ${errorMsg}`);
    return { done: true, error: errorMsg };
  } else if (messageType === 0xc) { // frontend server response
    return { done: false };
  } else {
    return { done: true, error: "未定义的消息类型" };
  }
}

/**
 * 播放音频文件
 * @param {string} filePath 音频文件路径
 * @returns {Promise<void>}
 */
async function playAudio(filePath) {
  return new Promise((resolve, reject) => {
    let command;

    switch (process.platform) {
      case 'darwin':
        // macOS
        command = `afplay "${filePath}"`;
        break;
      case 'win32':
        // Windows - 使用PowerShell播放并等待完成
        command = `powershell -c "(New-Object Media.SoundPlayer '${filePath.replace(/\//g, '\\')}').PlaySync()"`;
        break;
      default:
        // Linux 或其他系统
        command = `mplayer "${filePath}" 2>/dev/null || mpg123 "${filePath}" 2>/dev/null || espeak "无法播放音频"`;
        break;
    }

    if (settings.tts_debug) {
      console.log(`正在播放音频: ${filePath}`);
    }

    exec(command, (error) => {
      if (error) {
        console.error(`播放音频时出错: ${error}`);
        reject(error);
      } else {
        if (settings.tts_debug) {
          console.log('音频播放完成');
        }
        resolve();
      }
    });
  });
}

// 导出用于测试的函数
export const testTTS = {
  useBytedanceTTS,
  useSystemTTS
};
