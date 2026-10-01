import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import { DownloadsProvider } from './lib/DownloadsContext';
import { Toaster } from './lib/toast';
import { AuthProvider } from './lib/AuthContext';
import { ThemeProvider } from './lib/theme';
import { SettingsDraftsProvider } from './lib/SettingsDrafts';
import { NavigationGuard } from './lib/NavigationGuard';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const router = createBrowserRouter([{
  path: '*',
  element: (
    <ThemeProvider>
      <AuthProvider>
        <SettingsDraftsProvider>
          <DownloadsProvider>
            <App />
            <NavigationGuard />
            <Toaster />
          </DownloadsProvider>
        </SettingsDraftsProvider>
      </AuthProvider>
    </ThemeProvider>
  ),
}]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);