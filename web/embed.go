// Package web 嵌入前端静态文件
package web

import "embed"

// js 是目录，go:embed 会递归嵌入其下所有文件；注意目录形式会跳过以 . 或 _ 开头的
// 文件，前端模块不要用这两种前缀命名。
//
//go:embed index.html style.css js favicon.svg login.html vendor manifest.json sw.js icon-192.png icon-512.png icon-512-maskable.png
var Assets embed.FS
