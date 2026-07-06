"use client";

import { BookOpen, X } from "lucide-react";
import type { CardGlossary } from "../../_lib/glossary";
import { acronymsForCardGlossary } from "../../_lib/glossary";

/**
 * The "back-face" of a KPI card: a translucent overlay revealing the plain-English BPO
 * glossary definition of the metric (plus its sub-metrics and any acronyms). Rendered
 * absolutely inside a relatively-positioned card; the card owns the flip state and click
 * handling. One shared surface so every card's definition reads identically.
 */
export function GlossaryBackFace({
  glossary,
  eyebrow,
  onClose,
}: {
  glossary: CardGlossary;
  eyebrow?: string;
  onClose?: () => void;
}) {
  const acronyms = acronymsForCardGlossary(glossary);
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[rgba(8,15,34,0.97)] backdrop-blur-md">
      <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 pt-4 pb-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-accent-cyan">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          Glossary
        </span>
        <span className="text-text-muted" aria-hidden>
          <X className="h-4 w-4" />
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="font-display text-[15px] font-bold leading-tight text-white">
          {glossary.primary.term}
        </p>
        <p className="mt-1.5 text-[12.5px] leading-[1.5] text-[#c4d3ee]">
          {glossary.primary.definition}
        </p>

        {glossary.related.length > 0 ? (
          <dl className="mt-3 space-y-2 border-t border-white/8 pt-3">
            {glossary.related.map((entry) => (
              <div key={entry.term}>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7ecaff]">
                  {entry.term}
                </dt>
                <dd className="mt-0.5 text-[12px] leading-[1.45] text-[#aebfe0]">
                  {entry.definition}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {acronyms.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/8 pt-3">
            {acronyms.map((a) => (
              <span
                key={a.term}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-[#9db4d8]"
              >
                <span className="font-semibold text-[#cfe0fb]">{a.term}</span>
                {" — "}
                {a.definition}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose?.();
        }}
        className="border-t border-white/10 px-4 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted transition hover:text-white"
      >
        Tap to close
      </button>
    </div>
  );
}
