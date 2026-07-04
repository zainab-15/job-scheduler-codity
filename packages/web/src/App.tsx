import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ProjectsPage } from './pages/Projects';
import { QueuesPage } from './pages/Queues';
import { QueueDetailPage } from './pages/QueueDetail';
import { JobExplorerPage } from './pages/JobExplorer';
import { JobDetailPage } from './pages/JobDetail';
import { WorkersPage } from './pages/Workers';
import { DeadLetterPage } from './pages/DeadLetter';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {/* R18: Overview is the post-login landing ("is anything on fire?"). */}
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<QueuesPage />} />
        <Route path="/queues/:queueId" element={<QueueDetailPage />} />
        <Route path="/jobs" element={<JobExplorerPage />} />
        <Route path="/jobs/:jobId" element={<JobDetailPage />} />
        <Route path="/workers" element={<WorkersPage />} />
        <Route path="/dead-letter" element={<DeadLetterPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Routes>
  );
}
