import { Outlet, useLocation } from "react-router-dom";
import { Sidebar, BottomNav } from "@/components/ui/Sidebar";
import { TopBar } from "@/components/ui/TopBar";
import { CockpitSettingsDialog } from "@/components/ui/CockpitSettingsDialog";
import { useWorkbenchIndex } from "@/data/adapter";
import { CockpitSettingsProvider } from "@/hooks/useCockpitSettings";

export function AppLayout() {
  const location = useLocation();
  const { syncError, refresh } = useWorkbenchIndex();

  return (
    <CockpitSettingsProvider onSaved={refresh}>
      <div className="app-shell">
        <Sidebar currentPath={location.pathname} />
        <div className="workspace-scroll">
          <TopBar />
          {syncError ? (
            <div className="stale-data-banner" role="alert">
              <span>数据可能不是最新</span>
              <button type="button" onClick={() => void refresh().catch(() => {})}>重新载入</button>
            </div>
          ) : null}
          <main>
            <Outlet />
          </main>
        </div>
        <BottomNav currentPath={location.pathname} />
      </div>
      <CockpitSettingsDialog />
    </CockpitSettingsProvider>
  );
}
