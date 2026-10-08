import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { app, authText } from '../i18n/ko';

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

export function Layout() {
  const { logout } = useAuth();
  return (
    <>
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <header className="app-header">
        <div className="container app-header-inner">
          <NavLink to="/mcp" className="brand" end>
            {app.title}
          </NavLink>
          <nav aria-label="주요 메뉴" className="app-nav">
            <NavLink to="/mcp" end className={navClass}>
              {app.nav.servers}
            </NavLink>
            <NavLink to="/mcp/hub" className={navClass}>
              {app.nav.hub}
            </NavLink>
            <NavLink to="/mcp/audit" className={navClass}>
              {app.nav.audit}
            </NavLink>
            <NavLink to="/settings/security" className={navClass}>
              {app.nav.security}
            </NavLink>
            <button type="button" className="nav-button" onClick={() => void logout()}>
              {authText.logout}
            </button>
          </nav>
        </div>
      </header>
      <main id="main" className="container" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

/** 로그인·설정 화면용 — 메뉴 없음 */
export function AuthLayout() {
  return (
    <>
      <header className="app-header">
        <div className="container app-header-inner">
          <span className="brand">{app.title}</span>
        </div>
      </header>
      <main id="main" className="container auth-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
