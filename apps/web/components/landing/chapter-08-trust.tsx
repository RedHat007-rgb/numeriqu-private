import { ChapterMarker } from "./chapter-marker"
import { Reveal } from "./reveal"

const pillars = [
  {
    label: "Encryption",
    title: "Sealed in transit. Sealed at rest.",
    body:
      "AES-256 at rest. TLS 1.3 in transit. Per-tenant encryption keys, rotated automatically.",
  },
  {
    label: "Isolation",
    title: "One organization can never see another.",
    body:
      "Row-level isolation enforced in the database, the API, and the UI. Verified by automated tests on every deploy.",
  },
  {
    label: "Audit",
    title: "Everything that happens leaves a trace.",
    body:
      "Every query, every export, every permission change is logged immutably. Streamed to your SIEM if you want.",
  },
  {
    label: "Sovereignty",
    title: "Your data is yours. We never resell it.",
    body:
      "EU and US residency. Read-only ERP access. Your books never train another company's model.",
  },
]

export function Trust() {
  return (
    <section
      id="trust"
      className="relative overflow-hidden border-y border-border/60 py-32 sm:py-40"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-5">
            <Reveal>
              <ChapterMarker numeral="VIII." label="Quiet by design" />
            </Reveal>
            <Reveal delay={80}>
              <h2 className="mt-6 font-serif text-balance text-[40px] leading-[1.04] tracking-[-0.02em] text-foreground sm:text-[54px] md:text-[64px]">
                Security isn&apos;t a section.
                <br />
                It&apos;s a <em className="italic text-primary">posture.</em>
              </h2>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-md text-[16px] leading-relaxed text-muted-foreground">
                CFOs don&apos;t buy a product because of a logo on a security
                page. They buy it because every interaction feels considered.
                Numeriqu was built that way from the first commit.
              </p>
            </Reveal>
            <Reveal delay={220}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {["SOC 2 Type II", "ISO 27001", "GDPR", "CCPA"].map((b) => (
                  <span
                    key={b}
                    className="rounded-full border border-border/70 bg-card/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground backdrop-blur"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>

          <div className="col-span-12 lg:col-span-7">
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {pillars.map((p, i) => (
                <Reveal key={p.label} delay={120 + i * 80}>
                  <li className="grid grid-cols-12 gap-4 py-7 sm:py-8">
                    <div className="col-span-12 sm:col-span-3">
                      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                        {String(i + 1).padStart(2, "0")} · {p.label}
                      </div>
                    </div>
                    <div className="col-span-12 sm:col-span-9">
                      <h3 className="font-serif text-[24px] leading-snug tracking-tight text-foreground sm:text-[28px]">
                        {p.title}
                      </h3>
                      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted-foreground">
                        {p.body}
                      </p>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
