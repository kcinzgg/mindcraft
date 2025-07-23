import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE = path.join(__dirname, '../../logs/token_stats.json');
const TOKEN_DETAIL_LOG = path.join(__dirname, '../../logs/token_details.csv');

// 确保日志目录存在
const ensureLogDir = () => {
  const logsDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
};

// 获取当前北京时间的ISO字符串
const getBeijingTime = () => {
  // 创建Date对象
  const now = new Date();
  // 调整为北京时间
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijingTime = new Date(utcTime + 8 * 3600000);
  
  // 手动构建ISO格式字符串并添加东八区标识
  const year = beijingTime.getFullYear();
  const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getDate()).padStart(2, '0');
  const hours = String(beijingTime.getHours()).padStart(2, '0');
  const minutes = String(beijingTime.getMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getSeconds()).padStart(2, '0');
  const milliseconds = String(beijingTime.getMilliseconds()).padStart(3, '0');
  
  // 返回格式：YYYY-MM-DDTHH:mm:ss.sss+08:00 (东八区)
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+08:00`;
};

// 获取当前北京日期（YYYY-MM-DD格式）
const getBeijingDate = () => {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijingTime = new Date(utcTime + 8 * 3600000);
  return beijingTime.toISOString().split('T')[0];
};

// 初始化或加载统计数据
const initStats = () => {
  ensureLogDir();
  
  if (!fs.existsSync(STATS_FILE)) {
    const initialStats = {
      totalTokens: {
        prompt: 0,
        completion: 0,
        total: 0
      },
      modelStats: {},
      apiStats: {},
      dailyStats: {},
      lastUpdated: getBeijingTime()
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(initialStats, null, 2));
    return initialStats;
  }
  
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch (e) {
    // console.error('Error loading token stats:', e);
    return {
      totalTokens: { prompt: 0, completion: 0, total: 0 },
      modelStats: {},
      apiStats: {},
      dailyStats: {},
      lastUpdated: getBeijingTime()
    };
  }
};

// 记录详细token使用日志到CSV文件
export const recordTokenDetail = (agentName, inputMessages, toolsNum, promptTokens, completionTokens, completionResponse = {}, metadata = {}) => {
  ensureLogDir();
  
  const uuid = uuidv4();
  const time = getBeijingTime();
  const totalTokens = promptTokens + completionTokens;
  
  // 处理CSV中的特殊字符
  const escapeCsvField = (field) => {
    if (field === null || field === undefined) return '';
    const stringField = String(field);
    // 如果字段包含逗号、换行符或双引号，则需要用双引号包裹
    if (stringField.includes(',') || stringField.includes('\n') || stringField.includes('"')) {
      // 将字段中的双引号替换为两个双引号
      return `"${stringField.replace(/"/g, '""')}"`;
    }
    return stringField;
  };
  
  // 清理和格式化消息内容
  const cleanAndFormat = (data) => {
    if (!data) return '';
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    return jsonStr.replace(/\s+/g, ' ').trim();
  };
  
  // 提取completion响应的关键信息
  const extractCompletionInfo = (completion) => {
    if (!completion || typeof completion !== 'object') return '';
    
    const info = {
      content: completion.message?.content || completion.content || '',
      finish_reason: completion.finish_reason || '',
      model: completion.model || metadata.model || '',
      choices_count: completion.choices ? completion.choices.length : (completion.content ? 1 : 0)
    };
    
    // 如果有完整的choices数组，记录更多信息
    if (completion.choices && completion.choices.length > 0) {
      info.all_choices = completion.choices.map(choice => ({
        content: choice.message?.content || choice.content || '',
        finish_reason: choice.finish_reason || '',
        index: choice.index || 0
      }));
    }
    
    return JSON.stringify(info);
  };
  
  const inputMessagesStr = cleanAndFormat(inputMessages);
  const completionInfoStr = extractCompletionInfo(completionResponse);
  const metadataStr = cleanAndFormat(metadata);
  
  const csvLine = [
    escapeCsvField(uuid),
    escapeCsvField(time),
    escapeCsvField(agentName),
    escapeCsvField(inputMessagesStr),
    escapeCsvField(toolsNum),
    escapeCsvField(promptTokens),
    escapeCsvField(completionTokens),
    escapeCsvField(totalTokens),
    escapeCsvField(completionInfoStr),
    escapeCsvField(metadataStr)
  ].join(',') + '\n';
  
  // 检查文件是否存在，不存在则创建并添加表头
  if (!fs.existsSync(TOKEN_DETAIL_LOG)) {
    const header = 'uuid,time,agent_name,input_messages,tools_num,prompt_tokens,completion_tokens,total_tokens,completion_response,metadata\n';
    fs.writeFileSync(TOKEN_DETAIL_LOG, header);
  }
  
  // 追加数据到CSV文件
  fs.appendFileSync(TOKEN_DETAIL_LOG, csvLine);
  
  console.log(`[Token Detail] Logged: ${uuid} | ${agentName} | ${promptTokens}/${completionTokens}/${totalTokens} tokens`);
  
  return { uuid, time, totalTokens };
};

// 更新recordTokenUsage函数以同时记录详细日志
export const recordTokenUsage = (modelName, promptTokens, completionTokens, api, agentName = '', inputMessages = '', toolsNum = 0, completionResponse = {}, metadata = {}) => {
  let stats = initStats();
  const today = getBeijingDate();
  
  // 更新总计
  stats.totalTokens.prompt += promptTokens;
  stats.totalTokens.completion += completionTokens;
  stats.totalTokens.total += (promptTokens + completionTokens);
  
  // 更新模型统计
  if (!stats.modelStats[modelName]) {
    stats.modelStats[modelName] = { prompt: 0, completion: 0, total: 0 };
  }
  stats.modelStats[modelName].prompt += promptTokens;
  stats.modelStats[modelName].completion += completionTokens;
  stats.modelStats[modelName].total += (promptTokens + completionTokens);
  
  // 更新API提供商统计
  if (!stats.apiStats[api]) {
    stats.apiStats[api] = { prompt: 0, completion: 0, total: 0 };
  }
  stats.apiStats[api].prompt += promptTokens;
  stats.apiStats[api].completion += completionTokens;
  stats.apiStats[api].total += (promptTokens + completionTokens);
  
  // 更新每日统计
  if (!stats.dailyStats[today]) {
    stats.dailyStats[today] = { prompt: 0, completion: 0, total: 0, models: {} };
  }
  stats.dailyStats[today].prompt += promptTokens;
  stats.dailyStats[today].completion += completionTokens;
  stats.dailyStats[today].total += (promptTokens + completionTokens);
  
  // 更新每日模型统计
  if (!stats.dailyStats[today].models[modelName]) {
    stats.dailyStats[today].models[modelName] = { prompt: 0, completion: 0, total: 0 };
  }
  stats.dailyStats[today].models[modelName].prompt += promptTokens;
  stats.dailyStats[today].models[modelName].completion += completionTokens;
  stats.dailyStats[today].models[modelName].total += (promptTokens + completionTokens);
  
  // 更新时间戳（使用北京时间）
  stats.lastUpdated = getBeijingTime();
  
  // 记录到控制台（方便调试）
  // console.log(`[Token Stats] ${api}/${modelName}: ${promptTokens} prompt + ${completionTokens} completion = ${promptTokens + completionTokens} tokens`);
  
  // 同时记录详细日志（如果提供了agent信息）
  if (agentName) {
    // 添加额外的元数据
    const enrichedMetadata = {
      ...metadata,
      model: modelName,
      api: api,
      timestamp: getBeijingTime()
    };
    recordTokenDetail(agentName, inputMessages, toolsNum, promptTokens, completionTokens, completionResponse, enrichedMetadata);
  }
  
  // 保存统计数据
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  
  return stats;
};

// 获取统计数据
export const getTokenStats = () => {
  return initStats();
};

// 获取token使用摘要
export const getTokenSummary = () => {
  const stats = initStats();
  const today = getBeijingDate();
  
  return {
    total: stats.totalTokens,
    today: stats.dailyStats[today] || { prompt: 0, completion: 0, total: 0 },
    byModel: Object.entries(stats.modelStats)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5),
    byAPI: stats.apiStats || {}
  };
};

// Token计数估算函数 (简单实现，仅用于没有API返回token计数的情况)
export const estimateTokenCount = (text) => {
  if (!text) return 0;
  // 简单估算：按照GPT模型的平均比例，约4个字符=1个token
  return Math.ceil(text.length / 4);
}; 