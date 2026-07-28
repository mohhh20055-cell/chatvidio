import { useRoute } from '@/lib/router';
import { useAuth } from '@/lib/auth';
import { Header, Footer } from '@/components/Layout';
import { LandingPage } from '@/pages/LandingPage';
import { LoginPage, RegisterPage } from '@/pages/AuthPages';
import { TeachersPage, OffersPage } from '@/pages/ListingPages';
import { TeacherProfilePage } from '@/pages/TeacherProfilePage';
import { LiveStreamsPage } from '@/pages/LiveStreamsPage';
import { StudentDashboardPage, TeacherDashboardPage } from '@/pages/DashboardPages';
import { Spinner } from '@/components/ui';

function App() {
  const route = useRoute();
  const { loading } = useAuth();

  const path = route.split('?')[0];
  const segments = path.split('/').filter(Boolean);

  let page: React.ReactNode;

  if (segments.length === 0) {
    page = <LandingPage />;
  } else if (segments[0] === 'login') {
    page = <LoginPage />;
  } else if (segments[0] === 'register') {
    page = <RegisterPage />;
  } else if (segments[0] === 'teachers') {
    page = <TeachersPage />;
  } else if (segments[0] === 'offers') {
    page = <OffersPage />;
  } else if (segments[0] === 'live') {
    page = <LiveStreamsPage />;
  } else if (segments[0] === 'teacher' && segments[1]) {
    page = <TeacherProfilePage />;
  } else if (segments[0] === 'student-dashboard') {
    page = <StudentDashboardPage />;
  } else if (segments[0] === 'teacher-dashboard') {
    page = <TeacherDashboardPage />;
  } else {
    page = (
      <div className="container-app py-20 text-center">
        <h1 className="text-4xl font-black text-[rgb(var(--ink))]">404</h1>
        <p className="mt-2 text-[rgb(var(--muted))]">الصفحة غير موجودة</p>
        <a href="#/" className="btn-primary mt-6">العودة للرئيسية</a>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="scale-150" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1">{page}</main>
      <Footer />
    </div>
  );
}

export default App;
