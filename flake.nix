{
  description = "A Nix-flake-based Node.js development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?rev=bc194f70731cc5d2b046a6c1b3b15f170f05999c";
  };

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
    in
    {
      devShells."${system}".default =
        let
          pkgs = import nixpkgs {
            inherit system;
          };
        in
        pkgs.mkShell {
          # create an environment with nodejs_18, pnpm, and yarn
          packages = with pkgs; [
            nodejs_18
            nodePackages.pnpm
          ];

          shellHook = ''
            echo "node `${pkgs.nodejs}/bin/node --version`"
          '';
        };
    };
}
