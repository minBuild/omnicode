import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { AuthLayout, Layout } from './components/Layout';
import { ServerListPage } from './pages/ServerListPage';
import { AddServerPage } from './pages/AddServerPage';
import { ServerDetailPage } from './pages/ServerDetailPage';
import { ChangesPage } from './pages/ChangesPage';
import { HubStatusPage } from './pages/HubStatusPage';
import { AuditPage } from './pages/AuditPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { SecurityPage } from './pages/SecurityPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** 경로는 packages/api/src/routes/spa.ts 의 SPA_PATHS 와 맞춘다 */
export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/setup" element={<SetupPage />} />
          </Route>
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Navigate to="/mcp" replace />} />
            <Route path="/mcp" element={<ServerListPage />} />
            <Route path="/mcp/add" element={<AddServerPage />} />
            <Route path="/mcp/servers/:id" element={<ServerDetailPage />} />
            <Route path="/mcp/servers/:id/changes" element={<ChangesPage />} />
            <Route path="/mcp/hub" element={<HubStatusPage />} />
            <Route path="/mcp/audit" element={<AuditPage />} />
            <Route path="/settings" element={<Navigate to="/settings/security" replace />} />
            <Route path="/settings/security" element={<SecurityPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
