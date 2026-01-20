// Package web 嵌入前端静态文件
package web

import "embed"

//go:embed index.html style.css app.js
var Assets embed.FS
