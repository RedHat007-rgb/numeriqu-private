import { Architecture } from "@/components/landing/chapter-05-architecture";
import { Ask } from "@/components/landing/chapter-06-ask";
import { Boundaries } from "@/components/landing/chapter-07-boundaries";
import { Trust } from "@/components/landing/chapter-08-trust";
import { Closing } from "@/components/landing/chapter-09-closing";
import { Fragmentation } from "@/components/landing/chapter-02-fragmentation";
import { OneBrain } from "@/components/landing/chapter-03-one-brain";
import { TwoMinds } from "@/components/landing/chapter-04-two-minds";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { Navbar } from "@/components/landing/navbar";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <Navbar />
      <Hero />
      <Fragmentation />
      <OneBrain />
      <TwoMinds />
      <Architecture />
      <Ask />
      <Boundaries />
      <Trust />
      <Closing />
      <Footer />
    </main>
  );
}
