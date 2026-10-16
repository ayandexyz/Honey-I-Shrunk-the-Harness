import Image from "next/image";
import { Layout, Navbar } from "nextra-theme-docs";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";
import "./globals.css";
import "./hero.css";

export const metadata = {
  title: "FreeCode",
  description: "Documentation for FreeCode",
};

const navbar = (
  <Navbar
    logo={
      <span className="navbar-brand">
        <Image src="/logo.png" alt="" width={28} height={28} priority />
        <span className="navbar-brand-wordmark">Histh!</span>
      </span>
    }
    projectLink="https://github.com/ayandexyz/omacode"
  />
);

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          darkMode={false}
          nextThemes={{ defaultTheme: "light", forcedTheme: "light" }}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
