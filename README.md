## LinkFlow

LinkFlow 是一个面向私有化部署的 **AI 搜索与智能体问答系统**：前端交互参考 Perplexica 的 UI/交互模式，后端基于 MiroFlow 的工具化智能体思路进行增强，通过统一的工具接口编排 Web 搜索、信息抽取、文档阅读等能力，形成“可控、可扩展、可观测”的智能体工作流。


https://github.com/user-attachments/assets/8872174b-850a-49a3-9b80-02a16dd95673







---

## 项目贡献

### 1) 基于 MiroFlow 的二次开发
- 保留了 MiroFlow 的高性能与高并发推理能力  
- 增加 **多轮对话 History 机制**：将每一轮的输入/输出、引用来源、工具调用信息等整理成可回放的数据结构，并在下一轮对话中自动组装使用  
  - 解决了“控制台一次性输出”难以支撑 Chat 产品的问题  
  - 让智能体真正具备连续对话的上下文与状态

### 2) 流式输出适配
- 将智能体执行过程拆成事件流回传（SSE/NDJSON 形式均可适配）  
- 前端可以边跑边展示：检索进度、工具调用进度、答案生成进度  
- 避免等待全流程结束后一次性输出，体验更接近真实聊天产品

### 3) 前端基于 Perplexica 的交互体验增强
- 交互与页面结构参考 Perplexica  
- 后端接入 MiroFlow Agent，把“工具调用 → 证据 → 回答”的链路串成更稳定的工作流  
- 新增独立的 Thinking 展示框：用于实时显示推理过程；最终 Answer 区域保持干净，仅展示最终结论

---

## 模型支持

目前已适配 **MiroThinker** 作为 LLM，可从 HuggingFace 下载：

- https://huggingface.co/miromind-ai/MiroThinker-v1.5-30B

---

## 快速开始（运行方式）

> Perplexica 和 MiroFlow 的环境安装与基础配置请参考原项目文档：

- Perplexica：https://github.com/ItzCrazyKns/Perplexica  
- MiroFlow：https://github.com/MiroMindAI/miroflow  

完成环境配置后：

### 1) 启动 MiroFlow 服务
```bash
cd miroflow
uvicorn api_server:app --host 0.0.0.0 --port 8000
```

### 2) 启动前端（LinkFlow）
```bash
cd ..
npm run dev
```

## 致谢
- 前端交互参考与部分实现基于：Perplexica (https://github.com/ItzCrazyKns/Perplexica  )
- 智能体与工具编排能力基于：MiroFlow (https://github.com/MiroMindAI/miroflow )
