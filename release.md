# Release 构建与发布指令

> 供 Agent 参考的完整构建流程。每次发版前务必按此文档执行。

---

## 1. 编译 Windows 可执行文件

```bash
cd /home/z/my-project/zhipu

# 必须加 --target=bun-windows-x64，否则编译出的是 Linux ELF 格式，Windows 无法运行
bun build --compile \
  --define "require.resolve=undefined" \
  --target=bun-windows-x64 \
  src/index.ts \
  --outfile release/zcode-proxy.exe
```

验证格式：
```bash
file release/zcode-proxy.exe
# 必须输出: PE32+ executable for MS Windows 6.00 (console), x86-64
# 如果输出 ELF 64-bit，说明忘了加 --target，Windows 会报"不兼容的16位应用程序"
```

---

## 2. 准备 release 目录文件

目录结构：
```
release/
├── zcode-proxy.exe    ← 上一步编译的
├── config.yaml        ← 从 config.example.yaml 复制
├── start.bat          ← Windows 启动脚本（必须纯 ASCII + CRLF 换行）
├── start.sh           ← Linux/macOS 启动脚本
└── README.md          ← 使用说明
```

### 2.1 config.yaml

```bash
cp config.example.yaml release/config.yaml
```

### 2.2 start.bat

**关键要求**：
- **必须纯 ASCII**，不能有中文（Windows CMD 默认 GBK 编码，中文会乱码）
- **必须 CRLF 换行符**（LF 会导致 `if/goto` 等多行结构解析失败）
- 包含 Plan 选择：OAuth 登录时区分 Coding Plan 和 Start Plan
- 导入也区分 Plan（`--plan=coding-plan` / `--plan=start-plan`）

生成方法：
```bash
cat > release/start.bat << 'BATCHEOF'
@echo off
echo.
echo ============================================
echo          zcode-proxy Manager
echo ============================================
echo.
echo   1. Start proxy server
echo   2. OAuth login (Bigmodel) - Coding Plan
echo   3. OAuth login (Z.AI) - Coding Plan
echo   4. OAuth login (Bigmodel) - Start Plan
echo   5. OAuth login (Z.AI) - Start Plan
echo   6. Import key from ZCode (Bigmodel)
echo   7. Import key from ZCode (Z.AI)
echo   8. Check login status
echo   9. Logout
echo   0. Exit
echo.
set /p choice=Select: 

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto login_bigmodel_cp
if "%choice%"=="3" goto login_zai_cp
if "%choice%"=="4" goto login_bigmodel_sp
if "%choice%"=="5" goto login_zai_sp
if "%choice%"=="6" goto import_bigmodel
if "%choice%"=="7" goto import_zai
if "%choice%"=="8" goto status
if "%choice%"=="9" goto logout
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
zcode-proxy.exe serve --config config.yaml
pause
goto end

:login_bigmodel_cp
echo.
echo Starting Bigmodel OAuth login (Coding Plan)...
zcode-proxy.exe auth login bigmodel --plan=coding-plan
pause
goto end

:login_zai_cp
echo.
echo Starting Z.AI OAuth login (Coding Plan)...
zcode-proxy.exe auth login zai --plan=coding-plan
pause
goto end

:login_bigmodel_sp
echo.
echo Starting Bigmodel OAuth login (Start Plan)...
zcode-proxy.exe auth login bigmodel --plan=start-plan
pause
goto end

:login_zai_sp
echo.
echo Starting Z.AI OAuth login (Start Plan)...
zcode-proxy.exe auth login zai --plan=start-plan
pause
goto end

:import_bigmodel
echo.
echo Importing key from ZCode (Bigmodel)...
zcode-proxy.exe auth login bigmodel --import
pause
goto end

:import_zai
echo.
echo Importing key from ZCode (Z.AI)...
zcode-proxy.exe auth login zai --import
pause
goto end

:status
echo.
zcode-proxy.exe auth status
pause
goto end

:logout
echo.
zcode-proxy.exe auth logout
pause
goto end

:end
BATCHEOF

# 转换为 CRLF 换行符
sed -i 's/$/\r/' release/start.bat
```

验证：
```bash
file release/start.bat
# 应输出: DOS batch file, ASCII text, with CRLF line terminators
```

### 2.3 start.sh

与 start.bat 对应的 Linux/macOS 版本，同样包含 Plan 选择：

```bash
cat > release/start.sh << 'SHEOF'
#!/usr/bin/env bash

echo ""
echo "============================================"
echo "         zcode-proxy Manager"
echo "============================================"
echo ""
echo "  1. Start proxy server"
echo "  2. OAuth login (Bigmodel) - Coding Plan"
echo "  3. OAuth login (Z.AI) - Coding Plan"
echo "  4. OAuth login (Bigmodel) - Start Plan"
echo "  5. OAuth login (Z.AI) - Start Plan"
echo "  6. Import key from ZCode (Bigmodel)"
echo "  7. Import key from ZCode (Z.AI)"
echo "  8. Check login status"
echo "  9. Logout"
echo "  0. Exit"
echo ""
read -p "Select: " choice

case $choice in
  1)
    echo ""
    echo "Starting proxy server..."
    echo ""
    chmod +x zcode-proxy.exe
    ./zcode-proxy.exe serve --config config.yaml
    ;;
  2)
    echo ""
    echo "Starting Bigmodel OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=coding-plan
    ;;
  3)
    echo ""
    echo "Starting Z.AI OAuth login (Coding Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=coding-plan
    ;;
  4)
    echo ""
    echo "Starting Bigmodel OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --plan=start-plan
    ;;
  5)
    echo ""
    echo "Starting Z.AI OAuth login (Start Plan)..."
    echo "Browser will open automatically for authorization..."
    echo ""
    ./zcode-proxy.exe auth login zai --plan=start-plan
    ;;
  6)
    echo ""
    echo "Importing key from ZCode (Bigmodel)..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import
    ;;
  7)
    echo ""
    echo "Importing key from ZCode (Z.AI)..."
    echo ""
    ./zcode-proxy.exe auth login zai --import
    ;;
  8)
    echo ""
    ./zcode-proxy.exe auth status
    ;;
  9)
    echo ""
    ./zcode-proxy.exe auth logout
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
SHEOF

chmod +x release/start.sh
```

### 2.4 README.md

更新版本号与 `package.json` 一致，包含多账号管理、Plan 绑定、凭证导入导出等使用说明。版本号从 `package.json` 读取：

```bash
VERSION=$(node -p "require('./package.json').version")
# 确认 README.md 中的版本号与 $VERSION 一致
```

---

## 3. 打包 zip

版本号从 `package.json` 读取：

```bash
cd /home/z/my-project/zhipu
VERSION=$(node -p "require('./package.json').version")

cd release
zip -9 ../zcode-proxy-v${VERSION}.zip zcode-proxy.exe config.yaml start.bat start.sh README.md
```

---

## 4. 推送代码到 GitHub

```bash
cd /home/z/my-project/zhipu

# 暂存 zip（不应提交到仓库，仅用于 Release 附件）
# 确保 .gitignore 包含 *.zip

git add -A
git commit -m "release: v{版本号}"
git push https://{用户名}:{token}@github.com/zhu748/zhipu.git main
```

---

## 5. 创建 GitHub Release 并上传

```bash
VERSION="0.1.0"  # 从 package.json 读取
TOKEN="{token}"
REPO="zhu748/zhipu"

# 创建 Release
RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "{
    \"tag_name\": \"v$VERSION\",
    \"target_commitish\": \"main\",
    \"name\": \"zcode-proxy v$VERSION\",
    \"body\": \"## zcode-proxy v$VERSION\\n\\n### 新特性\\n- 多账号管理 + Plan 绑定\\n- OAuth 登录支持 --plan 参数\\n- Dashboard Plan 编辑器\\n- 凭证导入/导出\\n\\n### 文件说明\\n- zcode-proxy.exe — Windows 可执行文件\\n- start.bat / start.sh — 启动脚本（含 Plan 选择）\\n- config.yaml — 配置模板\\n- README.md — 使用说明\",
    \"draft\": false,
    \"prerelease\": false
  }")

RELEASE_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 上传 zip 附件
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/zip" \
  --data-binary @zcode-proxy-v${VERSION}.zip \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=zcode-proxy-v${VERSION}.zip"
```

如果已有同版本 Release，需先删除旧 asset 再上传：
```bash
# 查询已有 asset
ASSET_ID=$(curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/$REPO/releases/tags/v$VERSION | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(a['id']) for a in d.get('assets',[])]")

# 删除旧 asset
curl -s -X DELETE \
  -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/$REPO/releases/assets/$ASSET_ID

# 再上传新的
```

---

## 6. 踩坑清单

| 坑 | 症状 | 解决 |
|----|------|------|
| 没加 `--target=bun-windows-x64` | Windows 报"不兼容的16位应用程序" | 编译时必须加 target |
| bat 文件含中文 | CMD 乱码，命令被截断 | 全部用英文 |
| bat 文件用 LF 换行 | `if/goto` 解析失败，命令被截断 | 必须 CRLF（`sed -i 's/$/\r/'`） |
| zip 包没含 config.yaml | 用户不知道怎么配置 | 必须包含模板配置 |
| OAuth 登录未指定 plan | 凭证默认 coding-plan，但用户可能需要 start-plan | 必须传 `--plan=` 参数 |
| 导入 ZCode 不区分 plan | 只读 coding-plan key，start-plan 用户导入失败 | 传 `--plan=start-plan`，导入函数会读取对应 key |
| 旧凭证无 plan 字段 | 启动时 plan 为 undefined | 自动回退 config.yaml 的全局 plan，兼容无需处理 |
| exe 超过 50MB | GitHub 推送时警告 | 可以忽略（仅警告不拒绝），或使用 Git LFS |

---

## 7. Plan 系统说明

项目支持两种计划，决定上游请求路由：

| Plan | 上游地址 | 认证方式 | 用途 |
|------|---------|---------|------|
| `coding-plan` | `{provider}.anthropicBase` / `{provider}.openaiBase` | `x-api-key: {apiKey}` | API Key 直连 |
| `start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | `Authorization: Bearer {jwt}` | 通过 ZCode 网关 |

**Plan 在以下位置生效**：
1. **CLI** — `auth login bigmodel --plan=start-plan`
2. **Dashboard** — OAuth/Add Key/Import 均有 Plan 选择器
3. **账号表** — Plan 列可直接下拉修改
4. **serve 启动** — 激活账号的 plan 会覆盖 config.yaml 的全局 plan

**凭证存储中的 plan 标签**：
- 旧凭证（v1 迁移或早期导入）可能没有 plan 字段 → 回退 config.yaml
- 通过 Dashboard 的 Plan 下拉可以给任何账号设置/修改 plan
- 修改激活账号的 plan 会自动同步到运行时 config

**导入 ZCode 配置时的 plan 行为**：
- `--plan=coding-plan`：读取 `builtin:{provider}-coding-plan` 的 API Key，同时捕获 start-plan JWT（如有）
- `--plan=start-plan`：以 `builtin:{provider}-start-plan` 的 JWT 为主凭证，coding-plan API Key 作补充标识
- 如果只有 start-plan token 没有 coding-plan key，使用 `--plan=start-plan` 导入，会给出提示
