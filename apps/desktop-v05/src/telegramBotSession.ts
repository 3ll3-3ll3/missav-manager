import { ref } from "vue";

// Bot Token 只在当前 WebView 进程内存中共享；不会写入 SQLite、日志或浏览器持久存储。
export const telegramBotSessionToken = ref("");
export const telegramBotSessionName = ref("");
