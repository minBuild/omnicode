import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ServerListPage } from './pages/ServerListPage';
import { AddServerPage } from './pages/AddServerPage';
import { ServerDetailPage } from './pages/ServerDetailPage';
import { ChangesPage } from './pages/ChangesPage';
import { HubStatusPage } from './pages/HubStatusPage';
import { AuditPage } from './pages/AuditPage';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/mcp" replace />} />
          <Route path="/mcp" element={<ServerListPage />} />
          <Route path="/mcp/add" element={<AddServerPage />} />
          <Route path="/mcp/servers/:id" element={<ServerDetailPage />} />
          <Route path="/mcp/servers/:id/changes" element={<ChangesPage />} />
          <Route path="/mcp/hub" element={<HubStatusPage />} />
          <Route path="/mcp/audit" element={<AuditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
