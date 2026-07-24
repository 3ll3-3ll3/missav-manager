const { existsSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..');
const builderCli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const { version } = require(join(root, 'package.json'));
const target = join(root, 'dist', `TG_Content_Toolbox_v${version}.exe`);

if (!existsSync(builderCli)) {
  console.error('未找到 electron-builder。请先运行 npm install 安装依赖。');
  process.exit(1);
}

if (process.platform === 'win32') {
  const targetImageName = `TG_Content_Toolbox_v${version}.exe`;
  const taskList = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${targetImageName}`, '/NH'], { encoding: 'utf8' });
  if (taskList.status === 0 && taskList.stdout.toLowerCase().includes(targetImageName.toLowerCase())) {
    console.error(`检测到 ${targetImageName} 正在运行。请先退出该版本，再重新执行打包。`);
    process.exit(1);
  }
}

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
process.env.npm_config_registry ||= 'https://registry.npmmirror.com';

console.log('开始构建 Windows 便携版（无签名、镜像优先、快速封装）。');
const result = spawnSync(process.execPath, [builderCli, '--win', 'portable', '--publish', 'never'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`无法启动 electron-builder: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);
if (!existsSync(target)) {
  console.error(`构建过程结束，但未找到预期产物：${target}`);
  process.exit(1);
}
console.log(`便携版已生成：${target}`);
