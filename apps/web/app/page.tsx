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

export default function Home() {
  return (
    <main className="w-full overflow-hidden bg-slate-900">
      <Navbar />
      <HeroSection />
      <DashboardPreview />
      <InsightsChatbot />
      <FeaturesGrid />
      <Testimonials />
      <Pricing />
      <CTABanner />
      <Footer />
    </main>
  );
}
