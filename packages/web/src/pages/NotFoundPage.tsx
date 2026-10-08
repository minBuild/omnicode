import { Link } from 'react-router-dom';
import { app } from '../i18n/ko';

export function NotFoundPage() {
  return (
    <div className="card">
      <h1>404</h1>
      <p>{app.notFound}</p>
      <Link to="/mcp" className="btn">
        {app.goToList}
      </Link>
    </div>
  );
}
