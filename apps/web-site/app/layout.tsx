import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TG 内容工具箱 · 私人工作台",
  description: "对齐 Windows v0.5.13 使用体验的 TG 内容工具箱",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
