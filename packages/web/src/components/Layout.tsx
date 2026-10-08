import { NavLink, Outlet } from 'react-router-dom';
import { app } from '../i18n/ko';

export function Layout() {
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
            <NavLink to="/mcp" end className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {app.nav.servers}
            </NavLink>
            <NavLink to="/mcp/hub" className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {app.nav.hub}
            </NavLink>
            <NavLink to="/mcp/audit" className={({ isActive }) => (isActive ? 'active' : undefined)}>
              {app.nav.audit}
            </NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className="container" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
