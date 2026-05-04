import {
  Navbar,
  HeroSection,
  DashboardPreview,
  InsightsChatbot,
  FeaturesGrid,
  Testimonials,
  Pricing,
  CTABanner,
  Footer,
} from "@repo/ui";
import { ThemeToggle } from "../components/ui/ThemeToggle";

export default function Home() {
  return (
    <main className="w-full overflow-hidden bg-bg-base">
      <Navbar trailing={<ThemeToggle />} />
      <HeroSection />
      <section id="platform">
        <DashboardPreview />
      </section>
      <InsightsChatbot />
      <FeaturesGrid />
      <Testimonials />
      <Pricing />
      <CTABanner />
      <Footer />
    </main>
  );
}
