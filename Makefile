.PHONY: build clean dev deps

# 变量
BINARY_NAME=heliox-mon
BUILD_DIR=build
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS=-s -w -X main.Version=$(VERSION)

# 目标平台
PLATFORMS=linux/amd64 linux/arm64

# 默认目标
all: deps build

# 安装依赖
deps:
	go mod tidy
	go mod download

# 本地开发构建
dev:
	go build -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/heliox-mon

# 生产构建（Linux）
build:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY_NAME)-linux-amd64 ./cmd/heliox-mon
	@echo "构建完成: $(BUILD_DIR)/$(BINARY_NAME)-linux-amd64"

# 交叉编译（需要交叉编译工具链）
build-all:
	@mkdir -p $(BUILD_DIR)
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; \
		arch=$${platform#*/}; \
		output=$(BUILD_DIR)/$(BINARY_NAME)-$$os-$$arch; \
		echo "构建 $$os/$$arch..."; \
		CGO_ENABLED=1 GOOS=$$os GOARCH=$$arch go build -ldflags "$(LDFLAGS)" -o $$output ./cmd/heliox-mon; \
	done

# 清理
clean:
	rm -rf $(BUILD_DIR)

# 运行测试
test:
	go test -v ./...

# 格式化代码
fmt:
	go fmt ./...
	goimports -w .

# 静态检查
lint:
	golangci-lint run
