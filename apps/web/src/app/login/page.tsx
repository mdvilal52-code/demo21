import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../lib/getCurrentUser';
import { Monogram } from '../../components/ui/Monogram';
import { LoginForm } from '../../components/LoginForm';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/dashboard');

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-16">
      <Monogram />
      <LoginForm />
    </main>
  );
}
