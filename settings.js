/*
 * @Author: nick nickzj@qq.com
 * @Date: 2025-04-30 16:59:55
 * @LastEditors: nick nickzj@qq.com
 * @LastEditTime: 2025-05-19 23:55:51
 * @FilePath: /mindcraft/settings.js
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
const settings = {
    "minecraft_version": "1.20.4", // supports up to 1.21.1
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    // "port": 55916,
    "port": 25565, // 本地paper服务器端口
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "host_mindserver": true, // if true, the mindserver will be hosted on this machine. otherwise, specify a public IP address
    "mindserver_host": "localhost",
    "mindserver_port": 8080,

    // ASR设置
    "enable_asr": true,          // 是否启用ASR功能
    "doubao_asr_key": '',        // 豆包ASR API密钥 (Access Key)
    "doubao_app_id": "9954471235", // 豆包ASR应用ID
    "doubao_token": "riXplQ9eQMUg1K1GJIqgt_kRSWZU3zW9", // 豆包ASR令牌
    "asr_language": 'zh',        // 默认识别语言
    "asr_auto_start": false,     // 是否自动启动ASR
    "asr_continuous": false,     // 是否连续监听
    "asr_confidence_threshold": 0.7,  // 识别结果可信度阈值
    "asr_debug": false,          // 是否启用ASR调试模式
    
    // TTS设置
    "tts_engine": "system",      // TTS引擎选择: "system"(系统TTS), "bytedance"(字节TTS)
    "enable_tts": true,          // 是否启用TTS功能
    "tts_debug": false,          // 是否启用TTS调试模式
    
    // 字节跳动TTS设置 
    "bytedance_tts_app_id": "9954471235",  // 字节TTS应用ID
    "bytedance_tts_token": "riXplQ9eQMUg1K1GJIqgt_kRSWZU3zW9", // 字节TTS令牌
    "bytedance_tts_voice": "zh_male_yangguangqingnian_emo_v2_mars_bigtts", // 字节TTS音色
    
    // VAD设置
    "asr_vad_mode": 1,           // 0:关闭, 1:手动(热键), 2:自动(语音检测), 3:持续模式
    "asr_silence_timeout": 2000, // 静音超时(毫秒)，超过此时间无声音则停止录音
    "asr_vad_threshold": 0.01,   // 语音活动检测阈值，值越小越灵敏
    "player_name": "nick",        // 玩家名称
    
    // the base profile is shared by all bots for default prompts/examples/modes
    "base_profile": "./profiles/defaults/survival.json", // also see creative.json, god_mode.json
    "profiles": [
        // "./andy.json",
        "./candy.json",
        // "./jack.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],
    "load_memory": false, // load memory from previous session
    // "init_message": "Respond with hello world and your name in chinese and always use chinese", // sends to all on spawn
    "init_message": "用中文打招呼，并始终用中文进行回复", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly
    "speak": true, // allows all bots to speak through system text-to-speech. works on windows, mac, on linux you need to `apt install espeak`
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.tencent.com/translate/docs/languages
    "show_bot_views": true, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : [], // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "verbose_commands": true, // show full command syntax
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    // ASR服务实例(单例)和初始化状态
    "asr_instance": null,        // ASR服务实例
    "asr_initialized": false,    // ASR服务是否已初始化
    "tts_instance": null,        // TTS服务实例
    "tts_initialized": false     // TTS服务是否已初始化
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = process.env.MINECRAFT_PORT;
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = process.env.MINDSERVER_PORT;
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
export default settings;
