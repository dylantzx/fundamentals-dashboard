// The real views, dashboard model and public folder, bundled in the shape createApp() takes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLogin } from '../../views/login.js';
import { renderSetup } from '../../views/setup.js';
import { renderDashboard } from '../../views/dashboard.js';
import { renderParentHome } from '../../views/parent.js';
import { renderComingNext, renderNotFound } from '../../views/placeholder.js';
import { buildDashboardModel } from '../../lib/dashboard-model.js';

export const views = { renderLogin, renderSetup, renderDashboard, renderParentHome, renderComingNext, renderNotFound };
export { buildDashboardModel };
export const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
