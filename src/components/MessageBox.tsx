'use client';

/* eslint-disable @next/next/no-img-element */
import React, { MutableRefObject, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  BookCopy,
  Disc3,
  Volume2,
  StopCircle,
  Layers3,
  Plus,
  CornerDownRight,
} from 'lucide-react';
import Markdown, { MarkdownToJSX, RuleType } from 'markdown-to-jsx';
import Copy from './MessageActions/Copy';
import Rewrite from './MessageActions/Rewrite';
import MessageSources from './MessageSources';
import SearchImages from './SearchImages';
import SearchVideos from './SearchVideos';
import { useSpeech } from 'react-text-to-speech';
import ThinkBox from './ThinkBox';
import { useChat, Section } from '@/lib/hooks/useChat';
import Citation from './MessageRenderer/Citation';
import AssistantSteps from './AssistantSteps';
import { ResearchBlock } from '@/lib/types';
import Renderer from './Widgets/Renderer';
import CodeBlock from './MessageRenderer/CodeBlock';

/**
 * 把模型输出里的 <use_mcp_tool> ... </use_mcp_tool> 整段移除，
 * 避免 markdown-to-jsx 把 <server_name>/<tool_name>/<arguments> 当成 HTML tag 渲染导致报错。
 */
const stripMcpToolXml = (text: string): string => {
  if (!text) return text;

  let out = text.replace(/<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/g, '');
  out = out
    .replace(/<\/?(server_name|tool_name|arguments|use_mcp_tool)>/g, '')
    .replace(/<\/?server_name>/g, '')
    .replace(/<\/?tool_name>/g, '')
    .replace(/<\/?arguments>/g, '');
  return out;
};

/**
 * 兜底：即便 useChat 已剥离，这里再剥一次，保证 Answer 永远不出现 <think>.
 */
const stripThinkXml = (text: string): string => {
  if (!text) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<\/?think>/gi, '');
  return out;
};

/**
 * ================
 * ✅ boxed 优先策略
 * - 如果最终文本里有 \boxed{...}：Answer 只显示 boxed 内部内容（覆盖/替代最后一次 think）
 * - 否则：Answer 显示 </think> 之后的内容（把 think 前半段扔掉）
 * - 最后：兜底剥离 think/mcp tag，防止脏数据穿透
 * ================
 */

// 解析最后一个 \boxed{...}，支持简单花括号嵌套
function extractLastBoxed(text: string): string | null {
  const s = String(text || '');
  const token = '\\boxed';
  const idx = s.lastIndexOf(token);
  if (idx === -1) return null;

  // skip whitespace after \boxed
  let j = idx + token.length;
  while (j < s.length && /\s/.test(s[j])) j++;

  if (j >= s.length || s[j] !== '{') return null;

  // parse balanced braces starting at '{'
  let depth = 0;
  let k = j;
  const innerStart = j + 1;
  let innerEnd = -1;

  while (k < s.length) {
    const ch = s[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        innerEnd = k;
        break;
      }
    }
    k++;
  }

  if (innerEnd === -1) return null;
  return s.slice(innerStart, innerEnd);
}

function stripPostThink(text: string): string {
  const s = String(text || '');
  const close = '</think>';
  const p = s.toLowerCase().lastIndexOf(close);
  if (p === -1) return s;
  return s.slice(p + close.length);
}

function normalizeFinalAnswer(raw: string): string {
  let s = String(raw || '');

  // 1) boxed 优先：只保留 boxed 的内部内容（你要的“覆盖掉最后一次思考”）
  const boxed = extractLastBoxed(s);
  if (boxed && boxed.trim()) {
    s = boxed;
  } else {
    // 2) 没 boxed：显示 </think> 之后（如果有）
    s = stripPostThink(s);
  }

  // 3) 兜底清理：think + mcp tags
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<\/?think>/gi, '');
  s = s.replace(/<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/gi, '');
  s = s.replace(/<\/?(server_name|tool_name|arguments|use_mcp_tool)>/gi, '');

  return s.trim();
}

const MessageBox = ({
  section,
  sectionIndex,
  dividerRef,
  isLast,
}: {
  section: Section;
  sectionIndex: number;
  dividerRef?: MutableRefObject<HTMLDivElement | null>;
  isLast: boolean;
}) => {
  const { loading, sendMessage, rewrite, researchEnded, chatHistory } = useChat();

  // ✅ debug: 移到 useEffect，避免 import 前执行语句破坏模块
  useEffect(() => {
    console.log('[MessageBox] loaded', new Date().toISOString(), {
      sectionIndex,
      isLast,
      messageId: section.message.messageId,
    });
  }, [sectionIndex, isLast, section.message.messageId]);

  // ✅ Answer only
  const rawAnswer = section.parsedTextBlocks.join('\n\n');

  // ✅ 新逻辑：boxed 优先（覆盖 think）
  // 先剥 MCP（避免 markdown-to-jsx 把 tag 当 html），再做最终归一化
  const parsedAnswer = normalizeFinalAnswer(stripMcpToolXml(rawAnswer));

  const speechMessage = section.speechMessage || '';
  const thinkingEnded = section.thinkingEnded;

  const sourceBlocks = section.message.responseBlocks.filter(
    (block): block is typeof block & { type: 'source' } => block.type === 'source',
  );
  const sources = sourceBlocks.flatMap((block) => block.data);

  const hasAnswerContent = parsedAnswer.trim().length > 0;

  const { speechStatus, start, stop } = useSpeech({ text: speechMessage });

  const markdownOverrides: MarkdownToJSX.Options = {
    renderRule(next, node, renderChildren, state) {
      if (node.type === RuleType.codeInline) {
        return `\`${node.text}\``;
      }
      if (node.type === RuleType.codeBlock) {
        return (
          <CodeBlock key={state.key} language={node.lang || ''}>
            {node.text}
          </CodeBlock>
        );
      }
      return next();
    },
    overrides: {
      citation: { component: Citation },
      // ✅ 不再注册 think override（thinking 独立展示）
    },
  };

  return (
    <div className="space-y-6">
      <div className="w-full pt-8 break-words">
        <h2 className="text-black dark:text-white font-medium text-3xl lg:w-9/12">
          {section.message.query}
        </h2>
      </div>

      <div className="flex flex-col space-y-9 lg:space-y-0 lg:flex-row lg:justify-between lg:space-x-9">
        <div ref={dividerRef} className="flex flex-col space-y-6 w-full lg:w-9/12">
          {sources.length > 0 && (
            <div className="flex flex-col space-y-2">
              <div className="flex flex-row items-center space-x-2">
                <BookCopy className="text-black dark:text-white" size={20} />
                <h3 className="text-black dark:text-white font-medium text-xl">Sources</h3>
              </div>
              <MessageSources sources={sources} />
            </div>
          )}

          {section.message.responseBlocks
            .filter(
              (block): block is ResearchBlock =>
                block.type === 'research' && block.data.subSteps.length > 0,
            )
            .map((researchBlock) => (
              <div key={researchBlock.id} className="flex flex-col space-y-2">
                <AssistantSteps
                  block={researchBlock}
                  status={section.message.status}
                  isLast={isLast}
                />
              </div>
            ))}

          {isLast &&
            loading &&
            !researchEnded &&
            !section.message.responseBlocks.some(
              (b) => b.type === 'research' && b.data.subSteps.length > 0,
            ) && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200">
                <Disc3 className="w-4 h-4 text-black dark:text-white animate-spin" />
                <span className="text-sm text-black/70 dark:text-white/70">Brainstorming...</span>
              </div>
            )}

          {section.widgets.length > 0 && <Renderer widgets={section.widgets} />}

          {/* ✅ Thinking box: independent from Answer */}
          {section.thinkingText && section.thinkingText.trim().length > 0 ? (
            <ThinkBox content={section.thinkingText} thinkingEnded={thinkingEnded} />
          ) : null}

          <div className="flex flex-col space-y-2">
            {sources.length > 0 && (
              <div className="flex flex-row items-center space-x-2">
                <Disc3
                  className={cn(
                    'text-black dark:text-white',
                    isLast && loading ? 'animate-spin' : 'animate-none',
                  )}
                  size={20}
                />
                <h3 className="text-black dark:text-white font-medium text-xl">Answer</h3>
              </div>
            )}

            {hasAnswerContent && (
              <>
                <Markdown
                  className={cn(
                    'prose prose-h1:mb-3 prose-h2:mb-2 prose-h2:mt-6 prose-h2:font-[800] prose-h3:mt-4 prose-h3:mb-1.5 prose-h3:font-[600] dark:prose-invert prose-p:leading-relaxed prose-pre:p-0 font-[400]',
                    'max-w-none break-words text-black dark:text-white',
                  )}
                  options={markdownOverrides}
                >
                  {/* ✅ parsedAnswer 已经做过 boxed 优先 + think/mcp 兜底清理 */}
                  {parsedAnswer}
                </Markdown>

                {loading && isLast ? null : (
                  <div className="flex flex-row items-center justify-between w-full text-black dark:text-white py-4">
                    <div className="flex flex-row items-center -ml-2">
                      <Rewrite rewrite={rewrite} messageId={section.message.messageId} />
                    </div>
                    <div className="flex flex-row items-center -mr-2">
                      <Copy initialMessage={parsedAnswer} section={section} />
                      <button
                        onClick={() => {
                          if (speechStatus === 'started') stop();
                          else start();
                        }}
                        className="p-2 text-black/70 dark:text-white/70 rounded-full hover:bg-light-secondary dark:hover:bg-dark-secondary transition duration-200 hover:text-black dark:hover:text-white"
                      >
                        {speechStatus === 'started' ? (
                          <StopCircle size={16} />
                        ) : (
                          <Volume2 size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {isLast &&
                  section.suggestions &&
                  section.suggestions.length > 0 &&
                  hasAnswerContent &&
                  !loading && (
                    <div className="mt-6">
                      <div className="flex flex-row items-center space-x-2 mb-4">
                        <Layers3 className="text-black dark:text-white" size={20} />
                        <h3 className="text-black dark:text-white font-medium text-xl">Related</h3>
                      </div>
                      <div className="space-y-0">
                        {section.suggestions.map((suggestion: string, i: number) => (
                          <div key={i}>
                            <div className="h-px bg-light-200/40 dark:bg-dark-200/40" />
                            <button
                              onClick={() => sendMessage(suggestion)}
                              className="group w-full py-4 text-left transition-colors duration-200"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex flex-row space-x-3 items-center">
                                  <CornerDownRight
                                    size={15}
                                    className="group-hover:text-sky-400 transition-colors duration-200 flex-shrink-0"
                                  />
                                  <p className="text-sm text-black/70 dark:text-white/70 group-hover:text-sky-400 transition-colors duration-200 leading-relaxed">
                                    {suggestion}
                                  </p>
                                </div>
                                <Plus
                                  size={16}
                                  className="text-black/40 dark:text-white/40 group-hover:text-sky-400 transition-colors duration-200 flex-shrink-0"
                                />
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </>
            )}
          </div>
        </div>

        {hasAnswerContent && (
          <div className="lg:sticky lg:top-20 flex flex-col items-center space-y-3 w-full lg:w-3/12 z-30 h-full pb-4">
            <SearchImages
              query={section.message.query}
              chatHistory={chatHistory}
              messageId={section.message.messageId}
            />
            <SearchVideos
              chatHistory={chatHistory}
              query={section.message.query}
              messageId={section.message.messageId}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageBox;