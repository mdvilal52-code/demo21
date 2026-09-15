import { Monogram } from '../components/ui/Monogram';
import { EnquiryForm } from '../components/EnquiryForm';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-16">
      <Monogram />
      <EnquiryForm />
    </main>
  );
}
