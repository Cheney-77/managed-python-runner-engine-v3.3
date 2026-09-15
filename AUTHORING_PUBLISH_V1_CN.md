# v3.3 Authoring / Publish V1

这一层只补齐用户代码发布链路，不修改 Runner v3.3 的 Direct Invoke 核心。

## 支持范围

- Transform only
- Direct Invoke only
- Function / static method / class method / invocation-scoped instance method
- 参数来源：FlowFile Content、FlowFile Attribute、Processor Property、Constant
- Codec：bytes / text / json
- 用户项目根目录必须有 `requirements.txt`，允许为空
- AST 扫描不会 import 或执行用户代码
- 发布时重新做 immutable source snapshot + revision 校验

暂不支持：Source、initialize/finalize、processor-scoped object、persistent state、generator、多 FlowFile 输出。

## 新增服务

环境变量：

```bash
export PUBLISH_WORKSPACE_ROOT=/data/user-workspaces
export PUBLISH_CATALOG_ROOT=/data/catalog
export PUBLISH_BUILD_SERVICE_URL=http://127.0.0.1:9088
export PUBLISH_DEFAULT_PROFILE=standard
export PUBLISH_BUILD_TIMEOUT_SECONDS=1800
export PUBLISH_LISTEN_HOST=127.0.0.1
export PUBLISH_LISTEN_PORT=9090
export PUBLISH_LOG_LEVEL=INFO
```

启动：

```bash
mpr-publish-service --listen-host 127.0.0.1 --listen-port 9090
```

## 前端交互链路

### 1. 扫描 workspace

```http
POST /v1/operator-workspaces/scan
Content-Type: application/json

{
  "workspace": "tenant-a/project-x/operator-1",
  "python_path": "."
}
```

返回 callable catalog 和每个参数的推荐 binding。推荐值只用于 UI，用户需要确认。

### 2. 生成 draft contract

```http
POST /v1/operator-contracts/draft

{
  "workspace": "tenant-a/project-x/operator-1",
  "python_path": ".",
  "callable_id": "pipeline:convert",
  "name": "json-to-csv",
  "display_name": "JSON to CSV"
}
```

前端基于 draft 让用户修改参数来源、Codec、输出映射。

### 3. Validate

```http
POST /v1/operator-contracts/validate

{
  "workspace": "tenant-a/project-x/operator-1",
  "contract": { ... }
}
```

### 4. Publish

```http
POST /v1/operators/publish

{
  "workspace": "tenant-a/project-x/operator-1",
  "backend": "runner",
  "profile": "standard",
  "contract": { ... }
}
```

Publish Service 会：

1. snapshot 用户 workspace 到 staging/runtime
2. 重新扫描 snapshot，校验 source_revision
3. 编译 Canonical Contract -> compiled-plan.json
4. 读取 requirements.txt
5. 调 Build Service `/v1/runtime-environments/resolve`
6. 得到 READY `image@sha256`
7. 生成 `__dsc_entry__.py`、`operator.yaml`、`operator-contract.yaml`
8. 调现有 `OperatorPublisher`
9. 返回 release_id

最终 artifact 结构：

```text
operator.yaml
operator-contract.yaml
compiled-plan.json
publish-info.json
__dsc_entry__.py
runtime/
  requirements.txt
  <用户原始工程>
```

现有 Runner 仍然只看到：

```yaml
entrypoint: __dsc_entry__:process
```

因此 RunnerService / Agent / Child / Pool / Java Processor 都无需改变。

## Processor Property

Canonical Contract 中 property key 例如：

```text
delimiter
```

当前 generic NiFi Processor 对应的动态属性名仍然是：

```text
Parameter.delimiter
```

Publish API 返回 `properties[].nifi_property_name`，平台可以用它来配置 NiFi。

## python_path

普通项目使用：

```text
python_path = "."
```

`src` layout 使用：

```text
python_path = "src"
```

生成 adapter 会把 `runtime/<python_path>` 加入 `sys.path`，不会修改用户源码的 import。
