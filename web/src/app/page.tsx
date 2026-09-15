import { Agents, Channels, Compare, Pipeline, Twins } from "@/components/site/sections";
import { Cta } from "@/components/site/cta";
import { Footer } from "@/components/site/footer";
import { Hero } from "@/components/site/hero";
import { Nav } from "@/components/site/nav";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="flex-1">
        <Hero />
        <Channels />
        <Pipeline />
        <Twins />
        <Agents />
        <Compare />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
