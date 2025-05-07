import { AgentProcess } from './src/process/agent_process.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createMindServer } from './src/server/mind_server.js';
import { mainProxy } from './src/process/main_proxy.js';
import { readFileSync } from 'fs';

// 添加进程退出时的清理函数
function setupCleanupHandlers() {
    const cleanupAndExit = (signal) => {
        console.log(`\n收到${signal}信号，正在清理资源...`);
        
        try {
            // 关闭主代理
            if (mainProxy) {
                console.log('正在关闭主代理...');
                mainProxy.cleanup && mainProxy.cleanup();
            }
        } catch (error) {
            console.error('清理资源时出错:', error);
        }
        
        console.log('资源清理完成，正在退出程序');
        process.exit(0);
    };
    
    // 注册信号处理函数
    process.on('SIGINT', () => cleanupAndExit('SIGINT'));  // Ctrl+C
    process.on('SIGTERM', () => cleanupAndExit('SIGTERM')); // kill命令
}

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}

function getProfiles(args) {
    return args.profiles || settings.profiles;
}

async function main() {
    // 设置清理处理函数
    setupCleanupHandlers();
    
    if (settings.host_mindserver) {
        const mindServer = createMindServer(settings.mindserver_port);
    }
    mainProxy.connect();

    const args = parseArguments();
    const profiles = getProfiles(args);
    console.log(profiles);
    const { load_memory, init_message } = settings;

    for (let i=0; i<profiles.length; i++) {
        const agent_process = new AgentProcess();
        const profile = readFileSync(profiles[i], 'utf8');
        const agent_json = JSON.parse(profile);
        mainProxy.registerAgent(agent_json.name, agent_process);
        agent_process.start(profiles[i], load_memory, init_message, i, args.task_path, args.task_id);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

try {
    main();
} catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
}
