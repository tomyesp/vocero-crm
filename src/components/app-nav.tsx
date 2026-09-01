"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  FlaskConical,
  Inbox,
  Kanban,
  LogOut,
  Settings,
  Sparkles,
  Tag,
  Truck,
  Users,
  X,
} from "lucide-react";
import type { Branding } from "@/lib/branding";
import type { ThemePreference } from "@/lib/theme";
import { cn, initials } from "@/lib/utils";
import { signOut } from "@/lib/auth/client";
import { useEvents } from "@/components/use-events";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_VERSION, BUILD_COMMIT, versionLabel } from "@/lib/version";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Inbox;
  badge?: boolean;
};

const NAV: NavItem[] = [
  { href: "/inbox", label: "Bandeja", icon: Inbox, badge: true },
  { href: "/pipeline", label: "Pipeline", icon: Kanban },
  { href: "/contacts", label: "Contactos", icon: Users },
  { href: "/agent", label: "Agente", icon: Sparkles },
  { href: "/lab", label: "Laboratorio", icon: FlaskConical },
];

/** 015 — "Citas" solo existe si esta instancia encendió la agenda. */
const AGENDA_ITEM: NavItem = {
  href: "/bookings",
  label: "Citas",
  icon: CalendarDays,
};

/** 017 (fork RPM) — Inventario de maquinaria, detrás de `INVENTARIO`. */
const INVENTORY_ITEMS: NavItem[] = [
  { href: "/reservas", label: "Reservas", icon: CalendarRange },
  { href: "/maquinas", label: "Máquinas", icon: Truck },
  { href: "/tarifas", label: "Tarifas", icon: Tag },
];

export function AppNav({
  branding,
  userName,
  role,
  theme,
  commit,
  agenda = false,
  inventario = false,
  open = false,
  onClose,
}: {
  branding: Branding;
  userName: string;
  role: string;
  theme: ThemePreference;
  /**
   * Commit resuelto en el servidor. Gana al de build porque puede venir de la
   * plataforma cuando quien construyó no lo pasó como build-arg.
   */
  commit?: string;
  /**
   * 015 — ¿hay agenda en esta instancia? Viene del servidor por prop y no se
   * deduce de los datos: una instancia con la agenda encendida pero sin citas
   * todavía debe mostrar igual su pantalla.
   */
  agenda?: boolean;
  /** 017 (fork RPM) — ¿hay inventario de maquinaria? Mismo criterio que agenda. */
  inventario?: boolean;
  /** Solo aplica por debajo de `lg`: en escritorio el lateral es fijo. */
  open?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  async function refetchUnread() {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as {
      conversations: { unreadCount: number }[];
    };
    setUnread(data.conversations.reduce((a, c) => a + c.unreadCount, 0));
  }

  useEffect(() => {
    void refetchUnread();
  }, []);

  useEvents({
    onMessageNew: () => void refetchUnread(),
    onConversationUpdated: () => void refetchUnread(),
  });

  const sha = commit || BUILD_COMMIT;
  // Citas va después de Pipeline: es el paso siguiente de un trato, no una
  // sección aparte.
  let items = agenda ? [...NAV.slice(0, 2), AGENDA_ITEM, ...NAV.slice(2)] : NAV;
  // 017 — Reservas/Máquinas/Tarifas van después de Pipeline: son la operación
  // diaria del negocio de alquiler, no una sección de configuración.
  if (inventario) {
    const cut = agenda ? 3 : 2;
    items = [...items.slice(0, cut), ...INVENTORY_ITEMS, ...items.slice(cut)];
  }

  return (
    <aside
      // Móvil: cajón que se desliza desde la izquierda (siempre montado, así
      // la transición corre en ambos sentidos). Escritorio: columna fija.
      // `visibility` va en la transición a propósito: al cerrar mantiene el
      // cajón visible mientras se desliza y recién entonces lo oculta, que es
      // lo que lo saca del orden de tabulación en móvil.
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-[17rem] shrink-0 flex-col overflow-y-auto border-r bg-subtle px-3 pb-3.5 pt-4 transition-[transform,visibility] duration-200",
        "lg:static lg:visible lg:z-auto lg:w-56 lg:translate-x-0 lg:overflow-visible lg:transition-none",
        open ? "visible translate-x-0 shadow-pop" : "invisible -translate-x-full"
      )}
    >
      {/* Brand white-label */}
      <div className="mb-4 flex items-center gap-2.5 px-2">
        {/* En móvil el cajón necesita su propio cierre: el velo no siempre es
            alcanzable con el pulgar. */}
        <button
          onClick={onClose}
          aria-label="Cerrar el menú"
          className="-ml-1 rounded-md p-1.5 text-text-3 hover:bg-accent hover:text-foreground lg:hidden"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-sm bg-brand text-[15px] font-bold text-brand-fg"
          aria-hidden
        >
          {branding.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[16px] font-[650] leading-tight tracking-tight">
            {branding.name}
          </span>
          <span className="block text-[11px] text-text-3">CRM · WhatsApp</span>
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-[11px] rounded-sm px-2.5 py-2.5 text-sm font-medium transition-colors lg:py-2",
                active
                  ? "bg-brand-tint font-semibold text-brand-text"
                  : "text-text-2 hover:bg-accent"
              )}
            >
              <item.icon
                className={cn("h-[18px] w-[18px]", active ? "text-brand" : "text-text-3")}
                strokeWidth={1.7}
              />
              <span className="flex-1">{item.label}</span>
              {item.badge && unread > 0 && (
                <span
                  className={cn(
                    "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold",
                    active ? "bg-brand text-brand-fg" : "bg-border-strong text-text-2"
                  )}
                >
                  {unread}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <Link
        href="/settings"
        className={cn(
          "flex items-center gap-[11px] rounded-sm px-2.5 py-2 text-sm font-medium transition-colors",
          pathname.startsWith("/settings")
            ? "bg-brand-tint font-semibold text-brand-text"
            : "text-text-2 hover:bg-accent"
        )}
      >
        <Settings
          className={cn(
            "h-[18px] w-[18px]",
            pathname.startsWith("/settings") ? "text-brand" : "text-text-3"
          )}
          strokeWidth={1.7}
        />
        Ajustes
      </Link>

      <div className="mt-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2 hover:bg-accent">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-text">
          {initials(userName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{userName}</span>
          <span className="block text-[11px] text-text-3">
            {role === "owner" ? "Propietario" : "Equipo"} · En línea
          </span>
        </span>
        <ThemeToggle initial={theme} />
        <button
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          className="rounded p-1 text-text-3 hover:text-foreground"
          onClick={async () => {
            await signOut();
            router.push("/login");
            router.refresh();
          }}
        >
          <LogOut className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>

      {/* Qué versión está corriendo. Discreta pero siempre visible: la duda
          "¿ya se desplegó?" aparece justo cuando algo no funciona, y mandar a
          alguien a comparar commits en el servidor significa que no lo hará. */}
      {/* `text-2` y no `text-3`: a 11px, el gris más claro se queda en 3.2:1
          contra el fondo de la barra y no pasa AA. Discreta sí, ilegible no. */}
      {/* El nombre sale de la marca, no de una constante: esto es white-label,
          y una instancia rebautizada que dice "Vocero" en el tooltip delata el
          producto de debajo justo donde el operador la mira todos los días. */}
      <p
        className="mt-1.5 px-2.5 text-[11px] tabular-nums text-text-2"
        title={
          sha
            ? `${branding.name} ${APP_VERSION}, construido del commit ${sha}`
            : `${branding.name} ${APP_VERSION}`
        }
      >
        {versionLabel(sha)}
      </p>
    </aside>
  );
}
