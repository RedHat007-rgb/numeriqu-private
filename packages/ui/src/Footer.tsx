"use client";

import React from "react";

export const Footer: React.FC = () => {
  return (
    <footer className="bg-slate-950 border-t border-white/10 py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          {/* Logo Section */}
          <div>
            <h3 className="text-xl font-bold font-display text-white mb-2">
              Numeriqu
            </h3>
            <p className="text-sm text-text-muted">
              AI & RAG-Driven Analytical Platform for Modern Finance
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="font-bold text-white mb-4">Product</h4>
            <ul className="space-y-2">
              {["Platform", "Features", "Pricing", "Security"].map((link) => (
                <li key={link}>
                  <a
                    href="#"
                    className="text-sm text-text-muted hover:text-blue-400 transition-colors"
                  >
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="font-bold text-white mb-4">Resources</h4>
            <ul className="space-y-2">
              {["Documentation", "Blog", "API Docs", "Tutorials"].map(
                (link) => (
                  <li key={link}>
                    <a
                      href="#"
                      className="text-sm text-text-muted hover:text-blue-400 transition-colors"
                    >
                      {link}
                    </a>
                  </li>
                ),
              )}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="font-bold text-white mb-4">Company</h4>
            <ul className="space-y-2">
              {["About", "Contact", "Careers", "Status"].map((link) => (
                <li key={link}>
                  <a
                    href="#"
                    className="text-sm text-text-muted hover:text-blue-400 transition-colors"
                  >
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom Section */}
        <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row justify-between items-center">
          <p className="text-sm text-text-muted mb-4 md:mb-0">
            © 2026 Numeriqu. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a
              href="#"
              className="text-text-muted hover:text-blue-400 transition-colors"
            >
              Privacy Policy
            </a>
            <a
              href="#"
              className="text-text-muted hover:text-blue-400 transition-colors"
            >
              Terms of Service
            </a>
            <a
              href="https://linkedin.com"
              className="text-text-muted hover:text-blue-400 transition-colors"
            >
              LinkedIn
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
