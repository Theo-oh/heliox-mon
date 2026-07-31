// Package web 嵌入前端静态文件
package web

import "embed"

//go:embed index.html style.css app.js favicon.svg login.html vendor manifest.json sw.js icon-192.png icon-512.png
var Assets embed.FS
