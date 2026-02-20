package com.articulate.sigma;

import py4j.GatewayServer;
import com.articulate.sigma.KBmanager;

public class SigmaBridge {
    // Returns the singleton manager from SigmaKEE
    public KBmanager getMgr() {
        return KBmanager.getMgr();
    }

    public static void main(String[] args) {
        SigmaBridge app = new SigmaBridge();
        GatewayServer server = new GatewayServer(app);
        server.start();
        System.out.println("SIGMA_READY"); 
    }
}
