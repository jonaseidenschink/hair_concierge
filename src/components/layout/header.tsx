"use client"

import { useAuth } from "@/providers/auth-provider"
import {
  CalendarCheck,
  CircleUserRound,
  ListChecks,
  LogOut,
  MessageCircle,
  Shield,
  User,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

export function Header() {
  const { profile, signOut } = useAuth()
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)

  // Don't show header on auth or quiz pages
  if (pathname.startsWith("/auth") || pathname.startsWith("/quiz")) {
    return null
  }

  return (
    <header className="sticky top-0 z-40 relative bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-primary/20 after:to-transparent">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link href="/chat" className="flex items-center gap-2">
          <div className="flex items-center gap-[3px]">
            <span className="h-3.5 w-[3px] rounded-sm bg-primary" />
            <span className="h-3.5 w-[3px] rounded-sm bg-primary/60" />
            <span className="h-3.5 w-[3px] rounded-sm bg-primary/30" />
          </div>
          <span className="font-header text-2xl tracking-wide text-[var(--text-heading)]">
            chaarlie
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          <NavLink href="/chat" current={pathname}>
            <MessageCircle className="mr-1.5 h-4 w-4" />
            Chat
          </NavLink>
          <NavLink href="/routine" current={pathname}>
            <ListChecks className="mr-1.5 h-4 w-4" />
            Routine
          </NavLink>
          <NavLink href="/tracker" current={pathname}>
            <CalendarCheck className="mr-1.5 h-4 w-4" />
            Tagebuch
          </NavLink>
          <NavLink href="/profile" current={pathname}>
            <User className="mr-1.5 h-4 w-4" />
            Profil
          </NavLink>
          {profile?.is_admin && (
            <NavLink href="/admin" current={pathname}>
              <Shield className="mr-1.5 h-4 w-4" />
              Admin
            </NavLink>
          )}
          <button
            onClick={signOut}
            className="ml-2 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="h-4 w-4" />
            Abmelden
          </button>
        </nav>

        {/* Mobile menu button */}
        <button
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent md:hidden"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Menü öffnen"
        >
          <CircleUserRound className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="border-t bg-background p-4 md:hidden">
          <nav className="flex flex-col gap-1">
            <NavLink href="/chat" current={pathname} onClick={() => setMenuOpen(false)} mobile>
              <MessageCircle className="mr-1.5 h-4 w-4" />
              Chat
            </NavLink>
            <NavLink href="/routine" current={pathname} onClick={() => setMenuOpen(false)} mobile>
              <ListChecks className="mr-1.5 h-4 w-4" />
              Routine
            </NavLink>
            <NavLink href="/tracker" current={pathname} onClick={() => setMenuOpen(false)} mobile>
              <CalendarCheck className="mr-1.5 h-4 w-4" />
              Tagebuch
            </NavLink>
            <NavLink href="/profile" current={pathname} onClick={() => setMenuOpen(false)} mobile>
              <User className="mr-1.5 h-4 w-4" />
              Profil
            </NavLink>
            {profile?.is_admin && (
              <NavLink href="/admin" current={pathname} onClick={() => setMenuOpen(false)} mobile>
                <Shield className="mr-1.5 h-4 w-4" />
                Admin
              </NavLink>
            )}
            <button
              onClick={() => {
                setMenuOpen(false)
                signOut()
              }}
              className="inline-flex items-center rounded-md px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-accent"
            >
              <LogOut className="mr-1.5 h-4 w-4" />
              Abmelden
            </button>
          </nav>
        </div>
      )}
    </header>
  )
}

function NavLink({
  href,
  current,
  onClick,
  mobile,
  children,
}: {
  href: string
  current: string
  onClick?: () => void
  mobile?: boolean
  children: React.ReactNode
}) {
  const isActive = current === href || current.startsWith(href + "/")
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`inline-flex items-center rounded-md px-3 ${mobile ? "py-3" : "py-2"} text-sm font-medium transition-colors ${
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
    >
      {children}
    </Link>
  )
}
