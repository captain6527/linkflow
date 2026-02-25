'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, BrainCircuit } from 'lucide-react';

interface ThinkBoxProps {
  content: string;
  thinkingEnded: boolean;
}

const MAX_PREVIEW_CHARS = 6000;

const ThinkBox = ({ content, thinkingEnded }: ThinkBoxProps) => {
  // ✅ default expand; do NOT auto-collapse when finished
  const [isExpanded, setIsExpanded] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const displayText = useMemo(() => {
    const raw = String(content || '');

    // While streaming: show tail only to keep DOM light
    if (!thinkingEnded && raw.length > MAX_PREVIEW_CHARS) {
      const tail = raw.slice(-MAX_PREVIEW_CHARS);
      return `…(truncated)\n${tail}`;
    }

    return raw;
  }, [content, thinkingEnded]);

  useEffect(() => {
    // ✅ auto-expand while streaming so user sees it immediately
    if (!thinkingEnded) setIsExpanded(true);
    // ✅ DO NOT auto-collapse when thinking ends (user complaint)
  }, [thinkingEnded]);

  useEffect(() => {
    // Auto scroll to bottom while streaming & expanded
    if (!isExpanded) return;
    if (thinkingEnded) return;
    if (!bodyRef.current) return;

    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [displayText, isExpanded, thinkingEnded]);

  // If there's no think content at all, hide the entire box (optional but recommended)
  if (!content || String(content).trim() === '') {
    return null;
  }

  const headerText = thinkingEnded ? 'Thinking (finished)' : 'Thinking…';

  return (
    <div className="my-4 bg-light-secondary/50 dark:bg-dark-secondary/50 rounded-xl border border-light-200 dark:border-dark-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2 text-black/90 dark:text-white/90 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200"
      >
        <div className="flex items-center space-x-2">
          <BrainCircuit size={20} className="text-[#9C27B0] dark:text-[#CE93D8]" />
          <p className="font-medium text-sm">{headerText}</p>
        </div>
        {isExpanded ? (
          <ChevronUp size={18} className="text-black/70 dark:text-white/70" />
        ) : (
          <ChevronDown size={18} className="text-black/70 dark:text-white/70" />
        )}
      </button>

      {isExpanded && (
        <div
          ref={bodyRef}
          className="px-4 py-3 text-black/80 dark:text-white/80 text-sm border-t border-light-200 dark:border-dark-200 bg-light-100/50 dark:bg-dark-100/50 whitespace-pre-wrap max-h-[260px] overflow-auto"
        >
          {displayText}
        </div>
      )}
    </div>
  );
};

export default ThinkBox;