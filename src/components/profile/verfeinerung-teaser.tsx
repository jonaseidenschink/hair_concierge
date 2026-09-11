import { ProfileLockBadge } from "./profile-lock-badge"

/**
 * Free tier's stand-in for „Dein Haarprofil" (T15, freemium-scanner-first
 * PR5). A free user never has `hasRoutineAccess` (that signal only turns true
 * for a real Personal Plan owner, who is always premium — see
 * `hasRoutineTabAccess`'s doc comment), so `HairProfileSection` never renders
 * for them at all today. This teaser fills that spot instead: it names the
 * feature and opens the Premium sheet, it never shows fabricated progress.
 *
 * „Noch genauer" framing (binding constraint): the copy says refinement makes
 * an ALREADY-working profile more precise — it must never read as "your
 * current recommendations are incomplete or wrong".
 */
export function VerfeinerungTeaser({ onUnlock }: { onUnlock: () => void }) {
  return (
    <section aria-labelledby="verfeinerung-teaser-heading" className="mb-8">
      <h2
        id="verfeinerung-teaser-heading"
        className="font-[family-name:var(--font-display)] text-2xl font-medium text-[var(--text-heading)]"
      >
        Noch genauer werden
      </h2>
      <div className="mt-3 rounded-[16px] border border-[var(--brand-plum-light)] bg-[var(--brand-plum-ice)] p-4">
        <p className="text-sm text-[var(--brand-plum-darkest)]">
          Ein paar kurze Fragen zu deinem Alltag — deine Empfehlungen werden noch genauer.
        </p>
        <button
          type="button"
          data-verfeinerung-teaser-cta="true"
          aria-label="Verfeinerung freischalten — Premium"
          onClick={onUnlock}
          className="relative mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--brand-plum)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-plum-dark)]"
        >
          Verfeinerung freischalten
          <ProfileLockBadge />
        </button>
      </div>
    </section>
  )
}
