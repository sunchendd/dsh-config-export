# dsh-config-export

DSH（DeepSeek Harness）配置备份插件：在 Web GUI 侧边栏增加「配置备份」入口，勾选 `~/.dsh` 下的各配置项一键打包 `tar.gz` 备份，也可从备份包恢复。

## 功能

- **选择导出**：全局设置 / 插件 profile / SSH 主机配置 / Agent 预设 / 皮肤外观 / 任务看板 / 额度统计，各分区显示体积，可任选组合
- **敏感字段脱敏**：导出 SSH 配置时可选将 `password` / `passphrase` / `token` / `secret` 字段替换为 `__REDACTED__`
- **备份历史**：预览（查看包含条目与覆盖分区）、恢复、删除
- **安全恢复**：恢复前自动把现有相关配置快照到 `exports/safety/`；内置守卫拒绝恢复含脱敏字段的 SSH 备份（防止密码被 `__REDACTED__` 覆盖）
- **本地导入**：从本地 `.tar.gz` 备份包上传导入
- **主题自适应**：面板配色跟随 GUI 浅色 / 深色皮肤自动切换
- 备份输出到 `~/.dsh/exports/`

## 安装

```bash
dsh plugin --profile web add github:sunchendd/dsh-config-export
```

恢复 profile 类配置后需重启 `dsh web`；插件依赖如缺失可在 profile 目录执行 `dsh plugin --profile web install` 重装。

## 安全说明

- Host 路由仅接受 loopback 请求且拦截跨站调用
- 恢复操作前一律先在 `exports/safety/` 生成当前配置快照
- 脱敏备份在恢复时会被明确拒绝，避免静默丢失密码

## 许可

MIT
